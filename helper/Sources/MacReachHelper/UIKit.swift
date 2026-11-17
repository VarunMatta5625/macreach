import AppKit

/// Small AppKit helpers shared by the menu bar, the setup assistant and the settings window.
final class ClosureButton: NSButton {
    var handler: (() -> Void)?
    convenience init(_ title: String, _ handler: @escaping () -> Void) {
        self.init(title: title, target: nil, action: nil)
        self.handler = handler; self.target = self; self.action = #selector(fire); self.bezelStyle = .rounded
    }
    @objc private func fire() { handler?() }
}

final class ClosureCheckbox: NSButton {
    var handler: ((Bool) -> Void)?
    convenience init(_ title: String, on: Bool, _ handler: @escaping (Bool) -> Void) {
        self.init(checkboxWithTitle: title, target: nil, action: nil)
        self.state = on ? .on : .off; self.handler = handler; self.target = self; self.action = #selector(fire)
    }
    @objc private func fire() { handler?(state == .on) }
}

final class ClosureMenuItem: NSMenuItem {
    var handler: (() -> Void)?
    convenience init(_ title: String, enabled: Bool = true, _ handler: @escaping () -> Void) {
        self.init(title: title, action: #selector(fire), keyEquivalent: "")
        self.handler = handler; self.target = self; self.isEnabled = enabled
    }
    @objc private func fire() { handler?() }
}

func label(_ s: String, size: CGFloat = 13, bold: Bool = false, color: NSColor = .labelColor, wrap: Bool = true) -> NSTextField {
    let t = NSTextField(wrappingLabelWithString: s)
    t.font = bold ? .boldSystemFont(ofSize: size) : .systemFont(ofSize: size)
    t.textColor = color; t.isSelectable = true
    t.lineBreakMode = wrap ? .byWordWrapping : .byTruncatingTail
    t.preferredMaxLayoutWidth = 420
    return t
}

func vstack(_ views: [NSView], spacing: CGFloat = 8) -> NSStackView {
    let s = NSStackView(views: views); s.orientation = .vertical; s.alignment = .leading; s.spacing = spacing; return s
}
func hstack(_ views: [NSView], spacing: CGFloat = 8) -> NSStackView {
    let s = NSStackView(views: views); s.orientation = .horizontal; s.alignment = .centerY; s.spacing = spacing; return s
}

/// One line of a checklist: state mark, title + detail, optional action button.
final class RowView: NSStackView {
    private let mark = NSTextField(labelWithString: "")
    private let title = label("", bold: true)
    private let detail = label("", size: 11, color: .secondaryLabelColor)
    private let button = ClosureButton("") {}
    init(title t: String, action: @escaping () -> Void) {
        super.init(frame: .zero)
        orientation = .horizontal; alignment = .top; spacing = 10
        title.stringValue = t; button.handler = action
        mark.font = .systemFont(ofSize: 16, weight: .bold); mark.setContentHuggingPriority(.required, for: .horizontal)
        let text = vstack([title, detail], spacing: 2); text.setContentHuggingPriority(.defaultLow, for: .horizontal)
        button.setContentHuggingPriority(.required, for: .horizontal)
        for v in [mark, text, button] { addArrangedSubview(v) }
        mark.widthAnchor.constraint(equalToConstant: 20).isActive = true
        self.title.preferredMaxLayoutWidth = 340; self.detail.preferredMaxLayoutWidth = 340
        text.widthAnchor.constraint(equalToConstant: 340).isActive = true
    }
    required init?(coder: NSCoder) { fatalError() }

    /// ok: true = done, false = needs action, nil = optional / not applicable.
    func set(ok: Bool?, detail d: String, button b: String?) {
        switch ok {
        case .some(true): mark.stringValue = "✓"; mark.textColor = .systemGreen
        case .some(false): mark.stringValue = "✕"; mark.textColor = .systemRed
        case .none: mark.stringValue = "–"; mark.textColor = .secondaryLabelColor
        }
        detail.stringValue = d
        button.title = b ?? ""; button.isHidden = (b == nil)
    }
}

enum Panes {
    static let screen = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
    static let accessibility = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
    static let notifications = "x-apple.systempreferences:com.apple.Notifications-Settings.extension"
    static func open(_ s: String) { if let u = URL(string: s) { NSWorkspace.shared.open(u) } }
}

func copyToPasteboard(_ s: String) {
    NSPasteboard.general.clearContents(); NSPasteboard.general.setString(s, forType: .string)
}

/// Permission state as seen by a fresh process: macOS only reports a new Screen Recording grant to processes started after it.
enum FreshPerms {
    static func read(_ cb: @escaping (Bool, Bool) -> Void) {
        DispatchQueue.global().async {
            let p = Process(); p.executableURL = URL(fileURLWithPath: CommandLine.arguments[0]); p.arguments = ["--status"]
            let o = Pipe(); p.standardOutput = o; p.standardError = Pipe()
            guard (try? p.run()) != nil else { return }
            let d = o.fileHandleForReading.readDataToEndOfFile(); p.waitUntilExit()
            let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
            DispatchQueue.main.async { cb((j?["screen"] as? Bool) ?? false, (j?["accessibility"] as? Bool) ?? false) }
        }
    }
    /// If a fresh process sees Screen Recording but this one does not, relaunch (launchd KeepAlive restarts us).
    static func relaunchIfStale(freshScreen: Bool) {
        if freshScreen && !Perms.screen() && ProcessInfo.processInfo.environment["XPC_SERVICE_NAME"] == "com.macreach.helper" { exit(0) }
    }
}
