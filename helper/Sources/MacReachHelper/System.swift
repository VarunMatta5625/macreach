import Foundation
import AppKit
import IOKit.pwr_mgt
import ApplicationServices

enum Perms {
    static func screen() -> Bool { CGPreflightScreenCaptureAccess() }
    static func accessibility() -> Bool { AXIsProcessTrusted() }
    static func locked() -> Bool {
        guard let d = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
        return (d["CGSSessionScreenIsLocked"] as? Bool) ?? false
    }
    static func requestAll() {
        _ = CGRequestScreenCaptureAccess()
        _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
    }
}

final class Power {
    private var idleAssertion: IOPMAssertionID = 0
    private var displayAssertion: IOPMAssertionID = 0
    private var lastActivity = Date.distantPast
    func hold() {
        if displayAssertion == 0 {
            IOPMAssertionCreateWithName(kIOPMAssertPreventUserIdleDisplaySleep as CFString, IOPMAssertionLevel(kIOPMAssertionLevelOn), "MacReach remote session" as CFString, &displayAssertion)
        }
        if idleAssertion == 0 {
            IOPMAssertionCreateWithName(kIOPMAssertPreventUserIdleSystemSleep as CFString, IOPMAssertionLevel(kIOPMAssertionLevelOn), "MacReach remote session" as CFString, &idleAssertion)
        }
        activity()
    }
    func release() {
        if displayAssertion != 0 { IOPMAssertionRelease(displayAssertion); displayAssertion = 0 }
        if idleAssertion != 0 { IOPMAssertionRelease(idleAssertion); idleAssertion = 0 }
    }
    /// Wakes the display / resets idle timers; rate-limited.
    func activity() {
        guard Date().timeIntervalSince(lastActivity) > 4 else { return }
        lastActivity = Date()
        var id: IOPMAssertionID = 0
        IOPMAssertionDeclareUserActivity("MacReach input" as CFString, kIOPMUserActiveLocal, &id)
    }
}

final class Clipboard {
    private let link: Link
    private let testInput: TestInput?
    private var lastChange: Int
    private var timer: Timer?
    private(set) var watching = false
    private var fake = ""
    private var lastText: String?   // last text pushed to / set from the client: stops echo loops

    init(link: Link, testInput: TestInput?) {
        self.link = link; self.testInput = testInput
        lastChange = NSPasteboard.general.changeCount
    }

    func watch(_ on: Bool) {
        watching = on
        timer?.invalidate(); timer = nil
        guard on else { return }
        lastChange = NSPasteboard.general.changeCount
        timer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { [weak self] _ in self?.poll() }
    }

    private func poll() {
        let pb = NSPasteboard.general
        guard pb.changeCount != lastChange else { return }
        lastChange = pb.changeCount
        pushCurrent(force: false)
    }

    /// Reads whatever is on the pasteboard and sends it. Also used for explicit "pull".
    func pushCurrent(force: Bool = true) {
        if testInput != nil { link.sendJSON(["t": "clip", "text": fake]); return }
        let pb = NSPasteboard.general
        var msg: [String: Any] = ["t": "clip"]
        if let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
            msg["files"] = urls.prefix(50).map { $0.path }
        }
        if let s = pb.string(forType: .string), s.utf8.count <= 4 * 1024 * 1024 {
            if !force && msg["files"] == nil && s == lastText { return }
            lastText = s; msg["text"] = s
        }
        else if msg["files"] == nil,
                let tiff = pb.data(forType: .tiff) ?? pb.data(forType: .png),
                let rep = NSBitmapImageRep(data: tiff),
                let png = rep.representation(using: .png, properties: [:]), png.count <= 12 * 1024 * 1024 {
            msg["png"] = png.base64EncodedString()
        }
        if msg.count > 1 { link.sendJSON(msg) }
    }

    func set(text: String?, png: Data?) {
        if testInput != nil { fake = text ?? "[image]"; testInput?.setClip(fake); return }
        let pb = NSPasteboard.general
        pb.clearContents()
        if let t = text { pb.setString(t, forType: .string); lastText = t }
        if let p = png { pb.setData(p, forType: .png) }
        lastChange = pb.changeCount   // don't echo our own write
    }
}

enum Commands {
    static func run(_ name: String) {
        switch name {
        case "missionControl": launch("/usr/bin/open", ["-a", "Mission Control"])
        case "launchpad": launch("/usr/bin/open", ["-a", "Launchpad"])
        case "displaySleep": launch("/usr/bin/pmset", ["displaysleepnow"])
        default: break
        }
    }
    private static func launch(_ path: String, _ args: [String]) {
        let p = Process(); p.executableURL = URL(fileURLWithPath: path); p.arguments = args
        try? p.run()
    }
}
