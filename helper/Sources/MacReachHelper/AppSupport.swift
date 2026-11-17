import Foundation
import AppKit
import UserNotifications

/// Runs the `macreach` command line (the single place that knows how to pause, resume, kick, change config...).
enum CLI {
    /// The app's own command-line wrapper when this is the installed app; the ~/.local/bin link in a source checkout.
    static var path: String {
        let own = Bundle.main.bundlePath + "/Contents/Resources/macreach-cli"
        return FileManager.default.isExecutableFile(atPath: own) ? own : NSHomeDirectory() + "/.local/bin/macreach"
    }

    static func run(_ args: [String], completion: ((Int32, String, String) -> Void)? = nil) {
        DispatchQueue.global(qos: .userInitiated).async {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: path)
            p.arguments = args
            var env = ProcessInfo.processInfo.environment
            env["PATH"] = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", env["PATH"] ?? ""].joined(separator: ":")
            p.environment = env
            let o = Pipe(), e = Pipe()
            p.standardOutput = o; p.standardError = e
            do { try p.run() } catch { DispatchQueue.main.async { completion?(-1, "", "\(error.localizedDescription)") }; return }
            let od = o.fileHandleForReading.readDataToEndOfFile()
            let ed = e.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            let out = String(decoding: od, as: UTF8.self), err = String(decoding: ed, as: UTF8.self)
            DispatchQueue.main.async { completion?(p.terminationStatus, out, err) }
        }
    }

    static func json(_ args: [String], completion: @escaping ([String: Any]?) -> Void) {
        run(args) { code, out, _ in
            guard code == 0, let d = out.data(using: .utf8), let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { completion(nil); return }
            completion(j)
        }
    }

    /// Opens a Terminal window running a macreach command that needs a hidden prompt (password, 2FA secrets).
    /// A .command file is opened by Terminal directly, so no Automation permission is involved.
    static func openInTerminal(_ name: String, _ command: String) {
        let dir = NSHomeDirectory() + "/Library/Application Support/MacReach"
        let file = dir + "/\(name).command"
        let script = "#!/bin/bash\nclear\n\(command)\necho\nread -n 1 -s -r -p \"Press any key to close this window.\"\n"
        do {
            try script.write(toFile: file, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: file)
            NSWorkspace.shared.open(URL(fileURLWithPath: file))
        } catch { Alerts.error("Could not open Terminal", error.localizedDescription) }
    }
}

/// MacReach lives in the menu bar (no Dock icon) until one of its windows is open; then it behaves like a normal app, with a Dock icon,
/// and goes back to menu-bar-only when the last window closes.
enum Dock {
    private static var observing = false
    static func willShow() {
        NSApp.setActivationPolicy(.regular)
        guard !observing else { return }
        observing = true
        NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: nil, queue: .main) { _ in
            DispatchQueue.main.async {   // the closing window is still visible while the notification runs
                let open = NSApp.windows.contains { $0.isVisible && $0.styleMask.contains(.titled) && !($0 is NSPanel) }
                if !open { NSApp.setActivationPolicy(.accessory) }
            }
        }
    }
}

/// Menu bar of the app while its windows are open (Dock mode). Without it Cmd+C/V/A and Cmd+W do nothing in text fields and windows.
/// Cmd+Q goes through the same confirmed "Quit MacReach" as the menu bar item: a plain exit would only be restarted by launchd.
enum MainMenu {
    static func install() {
        let main = NSMenu()
        func add(_ title: String, _ items: [NSMenuItem]) {
            let top = NSMenuItem(title: title, action: nil, keyEquivalent: ""); let m = NSMenu(title: title)
            items.forEach { m.addItem($0) }; top.submenu = m; main.addItem(top)
        }
        func item(_ title: String, _ action: Selector?, _ key: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: action, keyEquivalent: key); i.keyEquivalentModifierMask = mods; return i
        }
        add("MacReach", [item("Hide MacReach", #selector(NSApplication.hide(_:)), "h"), .separator(), ClosureMenuItem("Quit MacReach…") { AppActions.stopUntilLogin() }.keyed("q")])
        add("Edit", [item("Undo", Selector(("undo:")), "z"), item("Redo", Selector(("redo:")), "z", [.command, .shift]), .separator(),
                     item("Cut", #selector(NSText.cut(_:)), "x"), item("Copy", #selector(NSText.copy(_:)), "c"), item("Paste", #selector(NSText.paste(_:)), "v"),
                     item("Select All", #selector(NSText.selectAll(_:)), "a")])
        add("Window", [item("Close", #selector(NSWindow.performClose(_:)), "w"), item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m")])
        NSApp.mainMenu = main
    }
}

/// The downloadable app carries its own Node, Tailscale and server (Contents/Resources/macreach). Launching it from Finder sets up the
/// background jobs that run those copies; a source checkout does not use any of this.
enum Bundled {
    static var isBundled: Bool { FileManager.default.fileExists(atPath: Bundle.main.bundlePath + "/Contents/Resources/macreach/server/src/index.js") }
    static var version: String { (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "dev" }
    /// Disk images mount at /Volumes and Gatekeeper may run a downloaded app from a random AppTranslocation path: jobs written from
    /// either would point at a place that disappears.
    static var inTemporaryLocation: Bool { let p = Bundle.main.bundlePath; return p.hasPrefix("/Volumes/") || p.contains("/AppTranslocation/") }
    /// Quarantine is set on the downloaded file; the background jobs start the app's inner programs with nobody there to approve them.
    static func clearQuarantine() {
        let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/xattr"); p.arguments = ["-dr", "com.apple.quarantine", Bundle.main.bundlePath]
        try? p.run(); p.waitUntilExit()
    }
    /// True when the launch agents already point at this copy of the app at this version.
    static var installed: Bool {
        let f = NSHomeDirectory() + "/Library/Application Support/MacReach/installed.json"
        guard let d = FileManager.default.contents(atPath: f), let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return false }
        guard (j["app"] as? String) == Bundle.main.bundlePath && (j["version"] as? String) == version else { return false }
        // "Quit MacReach" unloads the jobs; opening the app again must bring them back.
        let p = Process(); p.executableURL = URL(fileURLWithPath: "/bin/launchctl"); p.arguments = ["print", "gui/\(getuid())/com.macreach.server"]
        p.standardOutput = Pipe(); p.standardError = Pipe()
        guard (try? p.run()) != nil else { return false }
        p.waitUntilExit()
        return p.terminationStatus == 0
    }
    /// Runs `macreach install` from this app and waits for it. Returns the tool's error text, or nil on success.
    static func install() -> String? {
        let p = Process(); p.executableURL = URL(fileURLWithPath: CLI.path); p.arguments = ["install"]
        let e = Pipe(); p.standardError = e; p.standardOutput = Pipe()
        do { try p.run() } catch { return error.localizedDescription }
        p.waitUntilExit()
        let text = String(data: e.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return p.terminationStatus == 0 ? nil : (text.isEmpty ? "install failed (exit \(p.terminationStatus))" : text)
    }
    /// Removes the background jobs and moves the app to the Trash (the CLI does both, then stops this app last).
    static func uninstallAndTrash() { CLI.run(["uninstall"]) { _, _, _ in exit(0) } }
}

enum Alerts {
    static func error(_ title: String, _ text: String) {
        DispatchQueue.main.async {
            NSApp.activate(ignoringOtherApps: true)
            let a = NSAlert(); a.alertStyle = .warning; a.messageText = title; a.informativeText = text.trimmingCharacters(in: .whitespacesAndNewlines); a.runModal()
        }
    }
    /// Funnel refused: if the text carries a Tailscale approval link, offer to open it.
    static func funnelFailed(_ text: String) {
        DispatchQueue.main.async {
            NSApp.activate(ignoringOtherApps: true)
            let a = NSAlert(); a.alertStyle = .warning; a.messageText = "Funnel not turned on"
            a.informativeText = text.trimmingCharacters(in: .whitespacesAndNewlines)
            let link = text.range(of: "https://login\\.tailscale\\.com/[^\\s]+", options: .regularExpression).map { String(text[$0]) }
            if link != nil { a.addButton(withTitle: "Open Tailscale"); a.addButton(withTitle: "Cancel") }
            if a.runModal() == .alertFirstButtonReturn, let l = link { Panes.openURL(l) }
        }
    }
    static func confirm(_ title: String, _ text: String, ok: String) -> Bool {
        NSApp.activate(ignoringOtherApps: true)
        let a = NSAlert(); a.messageText = title; a.informativeText = text
        a.addButton(withTitle: ok); a.addButton(withTitle: "Cancel")
        return a.runModal() == .alertFirstButtonReturn
    }
    /// Asks the user to type an exact phrase before something irreversible-ish happens.
    static func typedConfirm(_ title: String, _ text: String, phrase: String) -> Bool {
        NSApp.activate(ignoringOtherApps: true)
        let a = NSAlert(); a.alertStyle = .critical; a.messageText = title; a.informativeText = text
        let f = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24)); f.placeholderString = "Type: \(phrase)"
        a.accessoryView = f
        a.addButton(withTitle: "Continue"); a.addButton(withTitle: "Cancel")
        a.window.initialFirstResponder = f
        return a.runModal() == .alertFirstButtonReturn && f.stringValue.trimmingCharacters(in: .whitespaces) == phrase
    }
}

/// Mac notifications from the helper itself (shown as "MacReach", not as Script Editor).
enum Notifier {
    private static var available: Bool { Bundle.main.bundleIdentifier != nil && Bundle.main.bundleURL.pathExtension == "app" }
    static func requestAuth() {
        guard available else { return }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }
    /// First launch: macOS shows its notification prompt once, with the other permission prompts.
    static func requestIfUndetermined() {
        guard available else { return }
        UNUserNotificationCenter.current().getNotificationSettings { s in if s.authorizationStatus == .notDetermined { requestAuth() } }
    }
    static func status(_ cb: @escaping (Bool) -> Void) {
        guard available else { cb(false); return }
        UNUserNotificationCenter.current().getNotificationSettings { s in
            let ok = s.authorizationStatus == .authorized || s.authorizationStatus == .provisional
            DispatchQueue.main.async { cb(ok) }
        }
    }
    static func post(_ title: String, _ body: String) {
        guard available else { return }
        let c = UNMutableNotificationContent(); c.title = title; c.body = body
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil)) { _ in }
    }
}
