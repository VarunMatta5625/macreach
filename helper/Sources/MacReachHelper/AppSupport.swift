import Foundation
import AppKit
import UserNotifications

/// Runs the `macreach` command line (the single place that knows how to pause, resume, kick, change config...).
enum CLI {
    static var path: String { NSHomeDirectory() + "/.local/bin/macreach" }

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

enum Alerts {
    static func error(_ title: String, _ text: String) {
        DispatchQueue.main.async {
            NSApp.activate(ignoringOtherApps: true)
            let a = NSAlert(); a.alertStyle = .warning; a.messageText = title; a.informativeText = text.trimmingCharacters(in: .whitespacesAndNewlines); a.runModal()
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
