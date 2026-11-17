import Foundation
import AppKit

setvbuf(stdout, nil, _IOLBF, 0)
signal(SIGPIPE, SIG_IGN)

var args = Array(CommandLine.arguments.dropFirst())
func arg(_ name: String) -> String? { if let i = args.firstIndex(of: name), i + 1 < args.count { return args[i + 1] }; return nil }
let testMode = args.contains("--test-pattern")
let dataDir = ("~/Library/Application Support/MacReach" as NSString).expandingTildeInPath
let socketPath = arg("--socket") ?? dataDir + "/helper.sock"

if args.contains("--version") { print("macreach-helper 1.0"); exit(0) }
if args.contains("--status") {
    print("{\"screen\":\(Perms.screen()),\"accessibility\":\(Perms.accessibility()),\"locked\":\(Perms.locked())}")
    exit(0)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

if args.contains("--request-permissions") {
    Perms.requestAll()
    // keep alive briefly so the system prompts can appear; user grants in Settings
    DispatchQueue.main.asyncAfter(deadline: .now() + 600) { exit(0) }
    app.run()
    exit(0)
}

try? FileManager.default.createDirectory(atPath: (socketPath as NSString).deletingLastPathComponent, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])

let link = Link(path: socketPath)
let testInput: TestInput? = testMode ? TestInput(logPath: arg("--input-log")) : nil
let cgInput = CGInput()
let input: InputSink = testInput ?? cgInput
let streamer = Streamer(link: link, testPattern: testMode, testInput: testInput, input: input)
let power = Power()
let clipboard = Clipboard(link: link, testInput: CommandLine.arguments.contains("--real-clipboard") ? nil : testInput)

func statusJSON() -> [String: Any] {
    let list = Displays.list(testPattern: testMode)
    return ["t": "status", "screen": testMode ? true : Perms.screen(), "accessibility": testMode ? true : Perms.accessibility(),
            "locked": Perms.locked(), "test": testMode, "streaming": streamer.running, "error": streamer.lastError ?? NSNull(),
            "displays": list.map { $0.json }, "display": streamer.currentDisplay.json, "version": "1.0", "pid": Int(getpid())]
}

func dbl(_ o: [String: Any], _ k: String) -> Double { (o[k] as? NSNumber)?.doubleValue ?? 0 }
func int(_ o: [String: Any], _ k: String) -> Int { (o[k] as? NSNumber)?.intValue ?? 0 }

func streamConfig(from o: [String: Any], base: StreamConfig) -> StreamConfig {
    var c = base
    if let v = o["codec"] as? String { c.codec = v }
    if let v = o["maxW"] as? NSNumber { c.maxW = v.intValue }
    if let v = o["maxH"] as? NSNumber { c.maxH = v.intValue }
    if let v = o["fps"] as? NSNumber { c.fps = max(1, min(120, v.intValue)) }
    if let v = o["bitrate"] as? NSNumber { c.bitrate = max(200_000, v.intValue) }
    if let v = o["jpegQ"] as? NSNumber { c.jpegQ = v.doubleValue }
    if let v = o["display"] as? NSNumber { c.displayID = v.uint32Value }
    return c
}
var currentCfg = StreamConfig()

// Menu bar item, setup assistant and settings only in the real, installed instance: a test helper (--test-pattern or a custom
// --socket) must never add a second icon to the user's menu bar.
let uiEnabled = !testMode && arg("--socket") == nil
if uiEnabled {
    StatusController.shared = StatusController()
    AppState.shared.refresh()
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
        if SetupWindow.needed { SetupWindow.show(); Perms.requestAll() }   // ask for everything up front; the assistant shows live status
        Notifier.requestIfUndetermined()
    }
}
final class AppDelegate: NSObject, NSApplicationDelegate {
    /// Opening MacReach.app again (Finder, Spotlight, `open`) shows Settings: a way in even if the menu bar icon is hidden by the notch.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { if uiEnabled { SettingsWindow.show() }; return true }
}
let appDelegate = AppDelegate()
app.delegate = appDelegate

link.onConnect = {
    link.sendJSON(statusJSON())
}
link.onDisconnect = {
    if uiEnabled { StatusController.reset() }
    streamer.stop(); input.releaseAll(); power.release()
    DispatchQueue.main.async { clipboard.watch(false) }
}
link.onCommand = { o in
    guard let c = o["c"] as? String else { return }
    switch c {
    case "start":
        currentCfg.displayID = nil   // a new client must not inherit the previous client's display choice
        currentCfg = streamConfig(from: o, base: currentCfg)
        power.hold()
        streamer.start(currentCfg)
    case "quality":
        currentCfg = streamConfig(from: o, base: currentCfg)
        streamer.update(currentCfg)
    case "stop": streamer.stop(); input.releaseAll(); power.release()
    case "keyframe": streamer.keyframe()
    case "status": link.sendJSON(statusJSON())
    case "ping": link.sendJSON(["t": "pong", "n": o["n"] ?? 0])
    case "mm": input.mouseMove(x: dbl(o, "x"), y: dbl(o, "y")); power.activity()
    case "mb": input.mouseButton(button: int(o, "b"), down: (o["d"] as? Bool) ?? true, x: dbl(o, "x"), y: dbl(o, "y"), clicks: int(o, "n")); power.activity()
    case "wh": input.scroll(dx: dbl(o, "dx"), dy: dbl(o, "dy")); power.activity()
    case "kd": if let k = o["k"] as? String { input.key(code: k, down: true, repeatEvent: (o["r"] as? Bool) ?? false); power.activity() }
    case "ku": if let k = o["k"] as? String { input.key(code: k, down: false, repeatEvent: false) }
    case "txt": if let s = o["s"] as? String { input.text(s); power.activity() }
    case "rel": input.releaseAll()
    case "scrollInvert": cgInput.invertScroll = (o["on"] as? Bool) ?? false
    case "clipwatch": let on = (o["on"] as? Bool) ?? false; DispatchQueue.main.async { clipboard.watch(on) }
    case "clippull": DispatchQueue.main.async { clipboard.pushCurrent() }
    case "clipset":
        let png = (o["png"] as? String).flatMap { Data(base64Encoded: $0) }
        clipboard.set(text: o["text"] as? String, png: png)   // synchronous: must land before the Cmd+V that follows
    case "cmd": if let n = o["n"] as? String { Commands.run(n) }
    case "perms": DispatchQueue.main.async { Perms.requestAll() }
    case "session": if uiEnabled { StatusController.apply(o) }
    default: break
    }
}

do { try link.start() } catch { FileHandle.standardError.write(Data("link start failed: \(error)\n".utf8)); exit(1) }
print("macreach-helper listening on \(socketPath) test=\(testMode)")

var testSignal: DispatchSourceSignal?   // must outlive the `if` below
if testMode {   // test only: `kill -USR1 <pid>` toggles between 1 and 3 simulated displays (a hot-unplug / hot-plug)
    signal(SIGUSR1, SIG_IGN)
    testSignal = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
    testSignal?.setEventHandler { Displays.testCount = Displays.testCount > 1 ? 1 : 3; streamer.displaysChanged(); if link.connected { link.sendJSON(statusJSON()) } }
    testSignal?.resume()
}
Displays.observe { streamer.displaysChanged(); if link.connected { link.sendJSON(statusJSON()) } }

// periodic status so the server notices permission/lock changes
Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { _ in if link.connected { link.sendJSON(statusJSON()) } }
app.run()
