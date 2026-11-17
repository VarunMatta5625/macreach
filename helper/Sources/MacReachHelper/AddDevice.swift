import AppKit
import CoreImage

enum QR {
    static func image(_ text: String, side: CGFloat) -> NSImage? {
        guard let f = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        f.setValue(Data(text.utf8), forKey: "inputMessage"); f.setValue("M", forKey: "inputCorrectionLevel")
        guard let out = f.outputImage else { return nil }
        let scale = side / out.extent.width
        let scaled = out.transformed(by: CGAffineTransform(scaleX: scale, y: scale))   // integer-ish scale keeps modules crisp
        let rep = NSCIImageRep(ciImage: scaled)
        let img = NSImage(size: NSSize(width: side, height: side)); img.addRepresentation(rep)
        return img
    }
}

/// Walks the user through connecting a phone or tablet: Tailscale app, same account, scan the link.
final class AddDeviceWindow: NSObject, NSWindowDelegate {
    static var shared: AddDeviceWindow?
    private let window: NSWindow
    private let qrView = NSImageView()
    private let urlLabel = label("", size: 12, color: .secondaryLabelColor)
    private let accountLabel = label("", size: 12)
    private let devicesLabel = label("", size: 12, color: .secondaryLabelColor)
    private let notReady = label("", size: 12, color: .systemOrange)
    private var lastUrl = ""

    static func show() { if shared == nil { shared = AddDeviceWindow() }; shared?.present() }

    override init() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 560), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        super.init()
        window.title = "Add a phone or tablet"; window.isReleasedWhenClosed = false; window.delegate = self
        qrView.widthAnchor.constraint(equalToConstant: 180).isActive = true; qrView.heightAnchor.constraint(equalToConstant: 180).isActive = true
        qrView.wantsLayer = true; qrView.layer?.backgroundColor = NSColor.white.cgColor; qrView.layer?.cornerRadius = 8
        let head = label("Add a phone or tablet", size: 20, bold: true)
        let step1 = vstack([label("1. Install Tailscale on the device", bold: true),
                            hstack([ClosureButton("App Store (iPhone, iPad)") { NSWorkspace.shared.open(URL(string: "https://apps.apple.com/app/tailscale/id1470499037")!) },
                                    ClosureButton("Google Play (Android)") { NSWorkspace.shared.open(URL(string: "https://play.google.com/store/apps/details?id=com.tailscale.ipn")!) }])], spacing: 6)
        let step2 = vstack([label("2. Sign in to Tailscale with the same account as this Mac", bold: true), accountLabel], spacing: 4)
        let step3 = vstack([label("3. Scan this with the device's camera, or open the link", bold: true),
                            hstack([qrView, vstack([urlLabel, ClosureButton("Copy link") { [weak self] in if let u = self?.lastUrl, !u.isEmpty { copyToPasteboard(u) } }], spacing: 10)], spacing: 16)], spacing: 8)
        let step4 = vstack([label("4. Sign in with your MacReach username and password", bold: true),
                            label("Tip: in Safari use Share > Add to Home Screen for a full-screen app. On Android Chrome use menu > Add to Home screen.", size: 12, color: .secondaryLabelColor)], spacing: 4)
        let fix = ClosureButton("Finish setup first…") { SetupWindow.show() }
        let stack = vstack([head, notReady, step1, step2, step3, step4, label("Devices on your Tailscale network", bold: true), devicesLabel, fix], spacing: 16)
        stack.edgeInsets = NSEdgeInsets(top: 22, left: 22, bottom: 22, right: 22)
        window.contentView = stack
        stack.widthAnchor.constraint(equalToConstant: 560).isActive = true
        fix.isHidden = true; fixButton = fix
        AppState.shared.onChange.append { [weak self] in self?.update() }
    }
    private var fixButton: NSButton?

    private func present() {
        AppState.shared.start(); update()
        fit(window); placeOnMenuBarScreen(window); NSApp.activate(ignoringOtherApps: true); window.makeKeyAndOrderFront(nil)
    }

    private func update() {
        let s = AppState.shared
        let ts = (s.info["tailscale"] as? [String: Any]) ?? [:]
        let url = s.privateUrl
        var missing: [String] = []
        if s.tsState != "Running" { missing.append("sign this Mac in to Tailscale") }
        else if url.isEmpty { missing.append("set up the private link") }
        if ts["httpsCerts"] as? Bool == false && s.tsState == "Running" { missing.append("turn on MagicDNS and HTTPS Certificates in the Tailscale admin page") }
        if !s.passwordSet { missing.append("set a password") }
        notReady.stringValue = missing.isEmpty ? "" : "Before a device can connect: " + missing.joined(separator: ", ") + "."
        notReady.isHidden = missing.isEmpty; fixButton?.isHidden = missing.isEmpty
        if url != lastUrl { lastUrl = url; qrView.image = url.isEmpty ? nil : QR.image(url, side: 180) }
        urlLabel.stringValue = url.isEmpty ? "(no private link yet)" : url
        accountLabel.stringValue = (ts["account"] as? String).flatMap { $0.isEmpty ? nil : "This Mac is signed in as \($0)." } ?? "Use the same account you signed this Mac in with."
        let devs = (ts["devices"] as? [[String: Any]]) ?? []
        devicesLabel.stringValue = devs.isEmpty ? "No other devices yet. Once the Tailscale app is signed in on your phone it shows up here." :
            devs.map { "\(($0["online"] as? Bool ?? false) ? "●" : "○")  \($0["name"] as? String ?? "?")  (\($0["os"] as? String ?? ""))" }.joined(separator: "\n")
        fit(window)
    }
    func windowWillClose(_ n: Notification) { AppState.shared.stop() }
}
