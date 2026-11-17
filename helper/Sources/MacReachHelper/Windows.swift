import AppKit

/// Shared model for both windows: latest `macreach info` plus fresh permission state.
final class AppState {
    static let shared = AppState()
    var info: [String: Any] = [:]
    var screen = Perms.screen(), accessibility = Perms.accessibility(), notifications = false
    var onChange: [() -> Void] = []
    private var timer: Timer?
    private var users = 0

    func refresh() {
        CLI.json(["info"]) { [weak self] j in if let j = j { self?.info = j; self?.fire() } }
        FreshPerms.read { [weak self] s, a in
            guard let self = self else { return }
            self.screen = s; self.accessibility = a || Perms.accessibility()
            FreshPerms.relaunchIfStale(freshScreen: s)
            self.fire()
        }
        Notifier.status { [weak self] ok in self?.notifications = ok; self?.fire() }
    }
    private func fire() { onChange.forEach { $0() } }
    /// Poll while a window is open.
    func start() { users += 1; if timer == nil { refresh(); timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.refresh() } } }
    func stop() { users = max(0, users - 1); if users == 0 { timer?.invalidate(); timer = nil } }

    var tsState: String { ((info["tailscale"] as? [String: Any])?["state"] as? String) ?? "Unknown" }
    var privateUrl: String { (info["privateUrl"] as? String) ?? "" }
    var publicUrl: String { (info["publicUrl"] as? String) ?? "" }
    var passwordSet: Bool { (info["passwordSet"] as? Bool) ?? false }
    var paused: Bool { (info["paused"] as? Bool) ?? false }
    func cfg(_ k: String) -> Any? { (info["config"] as? [String: Any])?[k] }
}

/// The permission and account rows are identical in the setup assistant and the settings window.
final class Checklist {
    let screenRow = RowView(title: "Screen Recording") { AppActions.grantScreen() }
    let axRow = RowView(title: "Accessibility (mouse and keyboard)") { AppActions.grantAccessibility() }
    let notifRow = RowView(title: "Notifications") { AppActions.grantNotifications() }
    let pwRow = RowView(title: "Password") { AppActions.setPassword() }
    let tsRow = RowView(title: "Tailscale (reach this Mac from your other devices)") { AppActions.tailscale() }
    let dnsRow = RowView(title: "MagicDNS and HTTPS certificates") { Panes.openURL("https://login.tailscale.com/admin/dns") }
    let urlRow = RowView(title: "Private link") { AppActions.enablePrivateUrl() }
    let keyRow = RowView(title: "Keep the link permanent (key expiry)") { Panes.openURL("https://login.tailscale.com/admin/machines") }
    var all: [RowView] { [screenRow, axRow, notifRow, pwRow, tsRow, dnsRow, urlRow, keyRow] }

    func update() {
        let s = AppState.shared
        screenRow.set(ok: s.screen, detail: s.screen ? "Granted." : "Needed to show your screen. Turn MacReach on in System Settings; the app restarts itself once you do.", button: s.screen ? nil : "Grant…")
        axRow.set(ok: s.accessibility, detail: s.accessibility ? "Granted." : "Needed so the remote device can move the mouse and type. Turn MacReach on in System Settings.", button: s.accessibility ? nil : "Grant…")
        notifRow.set(ok: s.notifications ? true : nil, detail: s.notifications ? "On: you get a notice when someone connects." : "Optional. Shows a notice when a remote session starts.", button: s.notifications ? nil : "Allow…")
        pwRow.set(ok: s.passwordSet, detail: s.passwordSet ? "Set (user \"\(s.info["username"] as? String ?? "")\"). Typed only in Terminal, never in this app." : "Required to sign in remotely. Opens Terminal; the password never passes through this app.", button: s.passwordSet ? "Change…" : "Set password…")
        switch s.tsState {
        case "Running": tsRow.set(ok: true, detail: "Signed in.", button: nil)
        case "NotInstalled": tsRow.set(ok: nil, detail: "Optional. Not installed. Without it MacReach only works on this Mac.", button: "Install…")
        default: tsRow.set(ok: nil, detail: "Optional. Not signed in (\(s.tsState)).", button: "Sign in…")
        }
        let ts = (s.info["tailscale"] as? [String: Any]) ?? [:]
        let running = s.tsState == "Running"
        if !running { dnsRow.set(ok: nil, detail: "Needs Tailscale first.", button: nil) }
        else if ts["httpsCerts"] as? Bool == true { dnsRow.set(ok: true, detail: "On.", button: nil) }
        else { dnsRow.set(ok: false, detail: "Turn both on once for your Tailscale account: MagicDNS and HTTPS Certificates.", button: "Open admin page") }
        if !running { keyRow.set(ok: nil, detail: "Needs Tailscale first.", button: nil) }
        else if let d = ts["keyExpiryDays"] as? Int { keyRow.set(ok: d > 30 ? nil : false, detail: "Tailscale signs this Mac out in \(d) days, which breaks the link. In the admin page choose this machine's menu > Disable key expiry.", button: "Open admin page") }
        else { keyRow.set(ok: true, detail: "Key expiry is off: the link stays valid.", button: nil) }
        urlRow.set(ok: s.privateUrl.isEmpty ? nil : true, detail: s.privateUrl.isEmpty ? (s.tsState == "Running" ? "Not set up yet." : "Needs Tailscale first.") : s.privateUrl, button: s.privateUrl.isEmpty ? (s.tsState == "Running" ? "Set up" : nil) : "Copy")
        urlRow.setAction { if !s.privateUrl.isEmpty { copyToPasteboard(s.privateUrl) } else { AppActions.enablePrivateUrl() } }
    }
}

extension RowView {
    func setAction(_ f: @escaping () -> Void) { (arrangedSubviews.last as? ClosureButton)?.handler = f }
}

enum AppActions {
    static func grantScreen() { _ = CGRequestScreenCaptureAccess(); Panes.open(Panes.screen) }
    static func grantAccessibility() { _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary); Panes.open(Panes.accessibility) }
    static func grantNotifications() { Notifier.requestAuth(); DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { Notifier.status { ok in if !ok { Panes.open(Panes.notifications) } } } }
    static func setPassword() { CLI.openInTerminal("set-password", "\"\(CLI.path)\" set-password") }
    static func tailscale() {
        if AppState.shared.tsState == "NotInstalled" {
            CLI.openInTerminal("install-tailscale", "brew install --formula tailscale && \"\(CLI.path)\" install && \"\(CLI.path)\" access login --open")
        } else { CLI.openInTerminal("tailscale-login", "\"\(CLI.path)\" access login --open") }
    }
    static func enablePrivateUrl() {
        CLI.run(["access", "serve"]) { code, out, err in
            AppState.shared.refresh()
            if code != 0 { Alerts.error("Could not set up the private link", (err.isEmpty ? out : err) + "\nTurn on MagicDNS and HTTPS Certificates at login.tailscale.com/admin/dns, then try again.") }
        }
    }
    static func togglePause() {
        CLI.run(["access", (StatusController.shared?.paused ?? AppState.shared.paused) ? "resume" : "pause"]) { _, _, _ in AppState.shared.refresh() }
    }
    static func disconnect() { CLI.run(["kick"]) { _, _, _ in } }
    static func signOutAll() {
        if Alerts.confirm("Sign out every device?", "Every signed-in browser must enter the password again, and the current remote session ends.", ok: "Sign out all") { CLI.run(["revoke-all"]) { _, _, _ in } }
    }
    static func funnelOn() {
        if Alerts.typedConfirm("Make MacReach public?", "Anyone on the internet will be able to reach your sign-in page at \(AppState.shared.privateUrl). They still need your password.", phrase: "go public") {
            CLI.run(["access", "funnel", "--confirm", "go public"]) { code, out, err in AppState.shared.refresh(); if code != 0 { Alerts.error("Funnel not turned on", err.isEmpty ? out : err) } }
        }
    }
    static func funnelOff() { CLI.run(["access", "funnel", "off"]) { _, _, _ in AppState.shared.refresh() } }
    static func stopUntilLogin() {
        if Alerts.confirm("Quit MacReach?", "Any remote session ends and remote access stops. MacReach starts again at your next login, or when you run \"macreach install\".", ok: "Quit") { CLI.run(["stop"]) { _, _, _ in } }
    }
    static func openLogs() { NSWorkspace.shared.open(URL(fileURLWithPath: NSHomeDirectory() + "/Library/Logs/MacReach")) }
    static func showAudit() { CLI.openInTerminal("audit", "\"\(CLI.path)\" audit 80") }
}

// MARK: - Setup assistant

final class SetupWindow: NSObject, NSWindowDelegate {
    static var shared: SetupWindow?
    private let window: NSWindow
    private let list = Checklist()
    private let summary = label("", size: 12, color: .secondaryLabelColor)
    private var cb: (() -> Void)?

    static func show() {
        if shared == nil { shared = SetupWindow() }
        shared?.present()
    }

    override init() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 520), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        super.init()
        window.title = "MacReach Setup"; window.isReleasedWhenClosed = false; window.delegate = self
        let head = label("Set up MacReach", size: 20, bold: true)
        let sub = label("Grant these once and MacReach is ready. Nothing here ever asks for your password in a window; that happens in Terminal.", size: 12, color: .secondaryLabelColor)
        let done = ClosureButton("Done") { [weak self] in self?.window.close() }
        done.keyEquivalent = "\r"
        let phone = ClosureButton("Add a phone or tablet…") { AddDeviceWindow.show() }
        let stack = vstack([head, sub] + list.all + [summary, hstack([done, phone])], spacing: 14)
        stack.edgeInsets = NSEdgeInsets(top: 22, left: 22, bottom: 20, right: 22)
        window.contentView = stack
        stack.widthAnchor.constraint(equalToConstant: 560).isActive = true
        cb = { [weak self] in self?.update() }
        AppState.shared.onChange.append(cb!)
    }

    private func present() {
        AppState.shared.start(); update()
        fit(window); placeOnMenuBarScreen(window); Dock.willShow(); NSApp.activate(ignoringOtherApps: true); window.makeKeyAndOrderFront(nil)
    }
    private func update() {
        list.update()
        let s = AppState.shared
        let ready = s.screen && s.accessibility
        summary.stringValue = ready ? (s.passwordSet ? "Ready. Open MacReach from the menu bar any time." : "Permissions done. Set a password to sign in remotely.") : "Still needed: " + [s.screen ? nil : "Screen Recording", s.accessibility ? nil : "Accessibility"].compactMap { $0 }.joined(separator: ", ") + "."
        window.contentView?.layoutSubtreeIfNeeded()
    }
    func windowWillClose(_ n: Notification) {
        UserDefaults.standard.set(true, forKey: "setupSeen"); AppState.shared.stop()
    }
    static var needed: Bool { !UserDefaults.standard.bool(forKey: "setupSeen") }
}

// MARK: - Settings

final class SettingsWindow: NSObject, NSWindowDelegate {
    static var shared: SettingsWindow?
    private let window: NSWindow
    private let list = Checklist()
    private let publicLabel = label("", size: 12, color: .secondaryLabelColor)
    private let funnelBtn = ClosureButton("") {}
    private let takeover = ClosureCheckbox("Let a new device take over from the current one", on: true) { _ in }
    private let clip = ClosureCheckbox("Sync the clipboard", on: true) { _ in }
    private let login = ClosureCheckbox("Start MacReach when I log in", on: true) { _ in }
    private let idle = NSTextField(string: "30")
    private var building = false

    static func show() { if shared == nil { shared = SettingsWindow() }; shared?.present() }

    override init() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 640), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        super.init()
        window.title = "MacReach Settings"; window.isReleasedWhenClosed = false; window.delegate = self
        takeover.handler = { on in CLI.run(["config", "set", "allowTakeover", on ? "true" : "false"]) { _, _, _ in } }
        clip.handler = { on in CLI.run(["config", "set", "clipboardSync", on ? "true" : "false"]) { _, _, _ in } }
        login.handler = { on in CLI.run(["autostart", on ? "on" : "off"]) { _, _, _ in } }
        idle.target = self; idle.action = #selector(idleChanged); idle.widthAnchor.constraint(equalToConstant: 56).isActive = true
        funnelBtn.handler = { [weak self] in _ = self; AppState.shared.publicUrl.isEmpty ? AppActions.funnelOn() : AppActions.funnelOff() }

        func section(_ t: String) -> NSTextField { label(t, size: 15, bold: true) }
        let general = vstack([section("General"), login], spacing: 8)
        let access = vstack([section("Remote access"), list.urlRow, hstack([publicLabel, funnelBtn]), takeover, clip,
                             hstack([label("Sign out an idle device after", wrap: false), idle, label("minutes", wrap: false)])], spacing: 10)
        let perms = vstack([section("Permissions"), list.screenRow, list.axRow, list.notifRow], spacing: 10)
        let acct = vstack([section("Account"), list.pwRow, list.tsRow, list.dnsRow, list.keyRow], spacing: 10)
        let tools = hstack([ClosureButton("Add phone or tablet…") { AddDeviceWindow.show() }, ClosureButton("Setup assistant…") { SetupWindow.show() }, ClosureButton("Audit log…") { AppActions.showAudit() }, ClosureButton("Open logs folder") { AppActions.openLogs() }])
        let stack = vstack([general, access, perms, acct, tools], spacing: 22)
        stack.edgeInsets = NSEdgeInsets(top: 22, left: 22, bottom: 22, right: 22)
        window.contentView = stack
        stack.widthAnchor.constraint(equalToConstant: 560).isActive = true
        AppState.shared.onChange.append { [weak self] in self?.update() }
    }

    @objc private func idleChanged() {
        let v = idle.integerValue
        if v >= 1 && v <= 1440 { CLI.run(["config", "set", "idleMinutes", String(v)]) { _, _, _ in } } else { idle.integerValue = (AppState.shared.cfg("idleMinutes") as? Int) ?? 30 }
    }
    private func present() {
        AppState.shared.start(); update()
        fit(window); placeOnMenuBarScreen(window); Dock.willShow(); NSApp.activate(ignoringOtherApps: true); window.makeKeyAndOrderFront(nil)
    }
    private func update() {
        list.update()
        let s = AppState.shared
        takeover.state = (s.cfg("allowTakeover") as? Bool ?? true) ? .on : .off
        clip.state = (s.cfg("clipboardSync") as? Bool ?? true) ? .on : .off
        if window.firstResponder !== idle.currentEditor() { idle.integerValue = (s.cfg("idleMinutes") as? Int) ?? 30 }
        let agents = s.info["agents"] as? [String: Any]
        login.state = ((agents?["server"] as? [String: Any])?["enabled"] as? Bool ?? true) ? .on : .off
        let pub = s.publicUrl
        publicLabel.stringValue = pub.isEmpty ? "Public access (Funnel): off. Only your own devices can reach this Mac." : "Public access (Funnel): ON at \(pub)"
        funnelBtn.title = pub.isEmpty ? "Turn on…" : "Turn off"
        funnelBtn.isHidden = pub.isEmpty && s.privateUrl.isEmpty
        window.contentView?.layoutSubtreeIfNeeded()
    }
    func windowWillClose(_ n: Notification) { AppState.shared.stop() }
}


/// Centre on the display that has the menu bar (window.center() can pick another monitor for an accessory app).
func placeOnMenuBarScreen(_ w: NSWindow) {
    guard let f = NSScreen.screens.first?.visibleFrame else { w.center(); return }
    w.setFrameOrigin(NSPoint(x: f.midX - w.frame.width / 2, y: f.midY - w.frame.height / 2))
}

/// Size the window to its content (rows wrap, so a hard-coded height clips).
func fit(_ w: NSWindow) {
    guard let v = w.contentView else { return }
    v.layoutSubtreeIfNeeded()
    w.setContentSize(v.fittingSize)
}
