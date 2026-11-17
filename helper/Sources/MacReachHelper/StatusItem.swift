import AppKit

/// Menu bar item: shows when a remote session is in control, and offers the quick actions.
final class StatusController: NSObject, NSMenuDelegate {
    static var shared: StatusController?

    struct Session { var active = false, selfView = false, paused = false; var device = "", ip = ""; var since = Date() }
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let menu = NSMenu()
    private(set) var session = Session()
    private var ticker: Timer?
    private var lastNotified: [String: Date] = [:]

    override init() {
        super.init()
        menu.delegate = self
        item.menu = menu
        item.button?.imagePosition = .imageLeading
        render()
        AppState.shared.onChange.append { [weak self] in self?.render() }
    }

    /// Called from the link thread; hops to main.
    static func apply(_ o: [String: Any]) {
        var s = Session()
        s.active = (o["active"] as? Bool) ?? false
        s.selfView = (o["selfView"] as? Bool) ?? false
        s.paused = (o["paused"] as? Bool) ?? false
        s.device = (o["device"] as? String) ?? ""; s.ip = (o["ip"] as? String) ?? ""
        if let ms = (o["since"] as? NSNumber)?.doubleValue, ms > 0 { s.since = Date(timeIntervalSince1970: ms / 1000) }
        DispatchQueue.main.async {
            guard let me = shared else { return }
            // One notice per device per 5 minutes (a page reload re-attaches and must not spam). Helper-posted, so it reads "MacReach".
            if s.active && !s.selfView && !me.session.active {
                let key = s.device + s.ip, now = Date()
                if now.timeIntervalSince(me.lastNotified[key] ?? .distantPast) > 300 { Notifier.post("Remote session started", "\(s.device) (\(s.ip)) is now controlling this Mac."); me.lastNotified[key] = now }
            }
            me.session = s; me.render()
        }
    }
    /// Server link lost: nobody can be controlling.
    static func reset() { DispatchQueue.main.async { var s = shared?.session ?? Session(); s.active = false; shared?.session = s; shared?.render() } }

    /// The server pushes the pause state with every change; the polled `info` is only a fallback while the link is down.
    var paused: Bool { link.connected ? session.paused : AppState.shared.paused }
    private var screenOK: Bool { AppState.shared.screen }
    private var axOK: Bool { AppState.shared.accessibility }

    private func render() {
        guard let b = item.button else { return }
        let needsPerm = !(screenOK && axOK)
        let name = paused ? "pause.circle" : (needsPerm && !session.active ? "exclamationmark.triangle" : "display")
        let img = NSImage(systemSymbolName: name, accessibilityDescription: "MacReach") ?? NSImage(systemSymbolName: "display", accessibilityDescription: "MacReach")
        img?.isTemplate = true
        b.image = img
        if session.active {
            b.contentTintColor = .systemRed
            b.attributedTitle = NSAttributedString(string: session.selfView ? " Local" : " In use", attributes: [.foregroundColor: NSColor.systemRed, .font: NSFont.menuBarFont(ofSize: 0)])
            b.toolTip = "MacReach: \(session.device) is controlling this Mac (since \(clock(session.since)))"
        } else {
            b.contentTintColor = nil; b.attributedTitle = NSAttributedString(string: "")
            b.toolTip = !link.connected ? "MacReach: server not running" : paused ? "MacReach: remote access paused" : (needsPerm ? "MacReach: permissions needed" : "MacReach: ready, nobody connected")
        }
        if session.active && ticker == nil { ticker = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in self?.render() } }
        if !session.active { ticker?.invalidate(); ticker = nil }
    }

    private func clock(_ d: Date) -> String { let f = DateFormatter(); f.timeStyle = .short; f.dateStyle = .none; return f.string(from: d) }
    private func ago(_ d: Date) -> String {
        let m = Int(Date().timeIntervalSince(d) / 60)
        return m < 1 ? "just now" : m < 60 ? "\(m) min" : "\(m / 60) h \(m % 60) min"
    }

    // MARK: menu

    func menuWillOpen(_ m: NSMenu) { AppState.shared.refresh(); rebuild() }
    func menuNeedsUpdate(_ m: NSMenu) { rebuild() }

    private func rebuild() {
        menu.removeAllItems()
        let s = AppState.shared
        func header(_ t: String) { let i = NSMenuItem(title: t, action: nil, keyEquivalent: ""); i.isEnabled = false; menu.addItem(i) }
        if session.active {
            header("● In use remotely")
            header("   \(session.device) · \(session.ip)")
            header("   connected \(ago(session.since))" + (session.selfView ? " (this Mac's own browser)" : ""))
            menu.addItem(ClosureMenuItem("Disconnect session") { AppActions.disconnect() })
        } else if !link.connected {
            header("Server not running")
        } else if paused {
            header("Remote access paused")
        } else {
            header("Ready · nobody connected")
        }
        if !session.active { let d = ClosureMenuItem("Disconnect session", enabled: false) {}; menu.addItem(d) }   // always listed; greyed out when nobody is connected
        menu.addItem(.separator())
        menu.addItem(ClosureMenuItem(paused ? "Resume remote access" : "Pause remote access") { AppActions.togglePause() })
        menu.addItem(ClosureMenuItem("Sign out all devices…") { AppActions.signOutAll() })
        menu.addItem(.separator())
        if !s.privateUrl.isEmpty {
            menu.addItem(ClosureMenuItem("Copy private link") { copyToPasteboard(s.privateUrl) })
            menu.addItem(ClosureMenuItem("Open on this Mac") { NSWorkspace.shared.open(URL(string: s.info["localUrl"] as? String ?? "http://localhost:7878/")!) })
        } else {
            menu.addItem(ClosureMenuItem("Set up private link…") { SetupWindow.show() })
        }
        if !s.publicUrl.isEmpty { header("⚠︎ Public access is ON"); menu.addItem(ClosureMenuItem("Turn public access off") { AppActions.funnelOff() }) }
        menu.addItem(.separator())
        if !(screenOK && axOK) {
            if !screenOK { menu.addItem(ClosureMenuItem("⚠︎ Grant Screen Recording…") { AppActions.grantScreen() }) }
            if !axOK { menu.addItem(ClosureMenuItem("⚠︎ Grant Accessibility…") { AppActions.grantAccessibility() }) }
            menu.addItem(.separator())
        }
        menu.addItem(ClosureMenuItem("Settings…") { SettingsWindow.show() })
        menu.addItem(ClosureMenuItem("Setup assistant…") { SetupWindow.show() })
        menu.addItem(.separator())
        menu.addItem(ClosureMenuItem("Quit MacReach…") { AppActions.stopUntilLogin() })
        let v = NSMenuItem(title: "MacReach 1.0", action: nil, keyEquivalent: ""); v.isEnabled = false; menu.addItem(v)
    }
}
