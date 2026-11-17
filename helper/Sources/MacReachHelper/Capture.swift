import Foundation
import ScreenCaptureKit
import CoreMedia
import CoreVideo
import CoreGraphics
import AppKit

struct DisplayInfo {
    var id: CGDirectDisplayID
    var ptsW: Int, ptsH: Int      // logical points
    var pxW: Int, pxH: Int        // native pixels
    var originX: Double, originY: Double
    var name: String
    var main: Bool
    var builtin = false
    var label = ""                // what the browser shows: "MacBook (built-in)", "Display 1 · LG UltraFine"
    var json: [String: Any] {
        ["id": Int(id), "ptsW": ptsW, "ptsH": ptsH, "pxW": pxW, "pxH": pxH, "name": name, "main": main, "builtin": builtin, "label": label.isEmpty ? name : label]
    }
}

enum Displays {
    /// Test mode only: how many fake displays to report (1...3). Changed at runtime with the "testdisplays" command.
    static var testCount = Int(ProcessInfo.processInfo.environment["MACREACH_TEST_DISPLAYS"] ?? "") ?? 1

    static func list(testPattern: Bool) -> [DisplayInfo] {
        var out: [DisplayInfo]
        if testPattern {
            out = [DisplayInfo(id: 1, ptsW: 1440, ptsH: 900, pxW: 2880, pxH: 1800, originX: 0, originY: 0, name: "Built-in Test", main: true, builtin: true),
                   DisplayInfo(id: 2, ptsW: 1920, ptsH: 1080, pxW: 1920, pxH: 1080, originX: 1440, originY: 0, name: "Test Monitor A", main: false),
                   DisplayInfo(id: 3, ptsW: 1080, ptsH: 1920, pxW: 1080, pxH: 1920, originX: -1080, originY: 0, name: "Test Monitor B (portrait)", main: false)]
            out = Array(out.prefix(max(1, min(3, testCount))))
        } else {
            var count: UInt32 = 0
            CGGetActiveDisplayList(0, nil, &count)
            var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
            CGGetActiveDisplayList(count, &ids, &count)
            let screens = NSScreen.screens
            out = ids.prefix(Int(count)).map { id in
                let b = CGDisplayBounds(id)
                var pxW = Int(b.width), pxH = Int(b.height)
                if let m = CGDisplayCopyDisplayMode(id) { pxW = m.pixelWidth; pxH = m.pixelHeight }
                let name = screens.first(where: { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == id })?.localizedName ?? "Display \(id)"
                return DisplayInfo(id: id, ptsW: Int(b.width), ptsH: Int(b.height), pxW: pxW, pxH: pxH, originX: b.origin.x, originY: b.origin.y,
                                   name: name, main: CGDisplayIsMain(id) != 0, builtin: CGDisplayIsBuiltin(id) != 0)
            }
        }
        // Stable order for the picker: built-in first, then left to right.
        out.sort { a, b in a.builtin != b.builtin ? a.builtin : (a.originX != b.originX ? a.originX < b.originX : a.id < b.id) }
        var n = 0
        for i in out.indices {
            if out[i].builtin { out[i].label = "MacBook (built-in)" } else { n += 1; out[i].label = "Display \(n) · \(out[i].name)" }
        }
        return out
    }

    /// Calls `onChange` (on the main queue) after displays are plugged, unplugged, rearranged or change resolution.
    private static var onChange: (() -> Void)?
    static func observe(_ cb: @escaping () -> Void) {
        onChange = cb
        CGDisplayRegisterReconfigurationCallback({ _, flags, _ in
            // The callback fires twice per change (begin, then done); act only once the change is finished.
            if flags.contains(.beginConfigurationFlag) { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { Displays.onChange?() }
        }, nil)
    }
}

protocol FrameSource: AnyObject {
    var onFrame: ((CVPixelBuffer) -> Void)? { get set }
    var onError: ((String) -> Void)? { get set }
    func start(display: DisplayInfo, width: Int, height: Int, fps: Int)
    func stop()
}

// MARK: - ScreenCaptureKit

final class SCKSource: NSObject, FrameSource, SCStreamOutput, SCStreamDelegate {
    var onFrame: ((CVPixelBuffer) -> Void)?
    var onError: ((String) -> Void)?
    private var stream: SCStream?
    private let q = DispatchQueue(label: "macreach.capture", qos: .userInteractive)
    private var gen = 0

    func start(display: DisplayInfo, width: Int, height: Int, fps: Int) {
        stop()
        gen += 1
        let myGen = gen
        Task {
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
                guard let d = content.displays.first(where: { $0.displayID == display.id }) ?? content.displays.first else {
                    self.onError?("no display"); return
                }
                let filter = SCContentFilter(display: d, excludingWindows: [])
                let cfg = SCStreamConfiguration()
                cfg.width = width
                cfg.height = height
                cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(1, fps)))
                cfg.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
                cfg.queueDepth = 3
                cfg.showsCursor = true
                cfg.scalesToFit = true
                cfg.colorSpaceName = CGColorSpace.sRGB
                let s = SCStream(filter: filter, configuration: cfg, delegate: self)
                try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: self.q)
                try await s.startCapture()
                if myGen != self.gen { try? await s.stopCapture(); return }
                self.stream = s
            } catch {
                self.onError?("capture failed: \(error.localizedDescription)")
            }
        }
    }

    func stop() {
        gen += 1
        let s = stream
        stream = nil
        if let s = s { Task { try? await s.stopCapture() } }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sb.isValid else { return }
        guard let atts = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let a = atts.first, let raw = a[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete,
              let pb = CMSampleBufferGetImageBuffer(sb) else { return }
        onFrame?(pb)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        self.stream = nil
        onError?("stream stopped: \(error.localizedDescription)")
    }
}

// MARK: - Test pattern (no permissions needed)

final class TestPatternSource: FrameSource {
    var onFrame: ((CVPixelBuffer) -> Void)?
    var onError: ((String) -> Void)?
    private var timer: DispatchSourceTimer?
    private let q = DispatchQueue(label: "macreach.testpattern")
    private var w = 0, h = 0
    private var n = 0
    weak var input: TestInput?
    private let staticAfter = Int(ProcessInfo.processInfo.environment["MACREACH_TEST_STATIC"] ?? "") ?? 0

    func start(display: DisplayInfo, width: Int, height: Int, fps: Int) {
        stop()
        w = width; h = height
        let t = DispatchSource.makeTimerSource(queue: q)
        t.schedule(deadline: .now(), repeating: .milliseconds(max(8, 1000 / max(1, fps))))
        t.setEventHandler { [weak self] in self?.tick() }
        t.resume()
        timer = t
    }
    func stop() { timer?.cancel(); timer = nil }

    private func tick() {
        n += 1
        if staticAfter > 0 && n > staticAfter { return }   // test only: simulate a screen that stopped changing
        var pbOut: CVPixelBuffer?
        let attrs: [CFString: Any] = [kCVPixelBufferIOSurfacePropertiesKey: [:], kCVPixelBufferMetalCompatibilityKey: true]
        guard CVPixelBufferCreate(nil, w, h, kCVPixelFormatType_32BGRA, attrs as CFDictionary, &pbOut) == kCVReturnSuccess, let pb = pbOut else { return }
        CVPixelBufferLockBaseAddress(pb, [])
        defer { CVPixelBufferUnlockBaseAddress(pb, []) }
        guard let ctx = CGContext(data: CVPixelBufferGetBaseAddress(pb), width: w, height: h, bitsPerComponent: 8,
                                  bytesPerRow: CVPixelBufferGetBytesPerRow(pb), space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return }
        let W = CGFloat(w), H = CGFloat(h)
        let phase = CGFloat(n % 600) / 600
        ctx.setFillColor(CGColor(red: 0.08 + 0.1 * phase, green: 0.1, blue: 0.2, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
        ctx.setStrokeColor(CGColor(gray: 1, alpha: 0.12)); ctx.setLineWidth(1)
        var gx: CGFloat = 0
        while gx < W { ctx.move(to: CGPoint(x: gx, y: 0)); ctx.addLine(to: CGPoint(x: gx, y: H)); gx += 80 }
        var gy: CGFloat = 0
        while gy < H { ctx.move(to: CGPoint(x: 0, y: gy)); ctx.addLine(to: CGPoint(x: W, y: gy)); gy += 80 }
        ctx.strokePath()
        // moving box
        let bx = (W - 120) * (0.5 + 0.5 * sin(CGFloat(n) / 40))
        ctx.setFillColor(CGColor(red: 0.95, green: 0.6, blue: 0.1, alpha: 1))
        ctx.fill(CGRect(x: bx, y: H * 0.3, width: 120, height: 120))
        // input state overlay
        let s = input?.snapshot() ?? InputSnapshot()
        let px = CGFloat(s.x) * W, py = H - CGFloat(s.y) * H
        ctx.setFillColor(CGColor(red: s.buttons != 0 ? 1 : 0.2, green: 1, blue: 0.4, alpha: 1))
        ctx.fillEllipse(in: CGRect(x: px - 10, y: py - 10, width: 20, height: 20))
        ctx.setStrokeColor(CGColor(red: 0.2, green: 1, blue: 0.4, alpha: 0.6))
        ctx.move(to: CGPoint(x: px, y: 0)); ctx.addLine(to: CGPoint(x: px, y: H))
        ctx.move(to: CGPoint(x: 0, y: py)); ctx.addLine(to: CGPoint(x: W, y: py)); ctx.strokePath()
        let gc = NSGraphicsContext(cgContext: ctx, flipped: false)
        NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = gc
        let font = NSFont.monospacedSystemFont(ofSize: 28, weight: .semibold)
        let attrs2: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.white]
        let lines = ["MacReach test pattern  frame \(n)  \(w)x\(h)",
                     "pos \(String(format: "%.3f,%.3f", s.x, s.y))  buttons \(s.buttons)  scroll \(Int(s.scrollX)),\(Int(s.scrollY))",
                     "keys: \(s.keys.joined(separator: " "))",
                     "text: \(s.text.suffix(60))",
                     "clip: \(s.clip.suffix(60))"]
        for (i, l) in lines.enumerated() { (l as NSString).draw(at: NSPoint(x: 24, y: H - 50 - CGFloat(i) * 38), withAttributes: attrs2) }
        NSGraphicsContext.restoreGraphicsState()
        onFrame?(pb)
    }
}
