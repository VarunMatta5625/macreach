import Foundation
import CoreVideo
import CoreGraphics

struct StreamConfig {
    var codec = "h264"           // "h264" | "jpeg"
    var maxW = 1920, maxH = 1200 // 0 = native
    var fps = 60
    var bitrate = 8_000_000
    var jpegQ = 0.6
    var displayID: UInt32? = nil
}

final class Streamer {
    private let link: Link
    private let testPattern: Bool
    private let testInput: TestInput?
    private let input: InputSink
    private let q = DispatchQueue(label: "macreach.streamer")
    private var source: FrameSource?
    private var encoder: FrameEncoder?
    private var encW = 0, encH = 0, encCodec = ""
    private var cfg = StreamConfig()
    private(set) var running = false
    private var lastPB: CVPixelBuffer?
    private var needKey = true
    private var seq: UInt32 = 0
    private var inflight = 0
    private var lastOut = Date()
    private var display: DisplayInfo
    private var retry: DispatchWorkItem?
    private(set) var lastError: String?
    private var capW = 0, capH = 0
    private var refineItem: DispatchWorkItem?

    init(link: Link, testPattern: Bool, testInput: TestInput?, input: InputSink) {
        self.link = link; self.testPattern = testPattern; self.testInput = testInput; self.input = input
        self.display = Displays.list(testPattern: testPattern).first ?? DisplayInfo(id: CGMainDisplayID(), ptsW: 1440, ptsH: 900, pxW: 2880, pxH: 1800, originX: 0, originY: 0, name: "Main display", main: true)   // no active display (all asleep): placeholder until one appears
    }

    var currentDisplay: DisplayInfo { display }

    func start(_ c: StreamConfig) {
        q.async {
            self.cfg = c
            self.running = true
            self.pickDisplay()
            self.beginCapture()
        }
    }

    func update(_ c: StreamConfig) {
        q.async {
            let old = self.cfg
            self.cfg = c
            guard self.running else { return }
            let displayChanged = c.displayID != old.displayID
            if displayChanged { self.pickDisplay() }
            let (w, h) = self.targetSize()
            if displayChanged || c.codec != old.codec || w != self.capW || h != self.capH || (c.fps != old.fps && !self.testPattern) {
                self.beginCapture()
            } else {
                self.encoder?.setRate(bitrate: c.bitrate, fps: c.fps)
                if let j = self.encoder as? JPEGEncoder { j.quality = c.jpegQ }
            }
        }
    }

    func stop() {
        q.async {
            self.running = false
            self.refineItem?.cancel()
            self.retry?.cancel()
            self.source?.stop(); self.source = nil
            self.encoder?.invalidate(); self.encoder = nil
            self.lastPB = nil
            self.encW = 0; self.encH = 0
        }
    }

    func keyframe() {
        q.async {
            guard self.running else { return }
            self.needKey = true
            if let pb = self.lastPB { self.encodeNow(pb); self.scheduleRefine() }
        }
    }

    /// Displays were plugged, unplugged or changed. Re-resolve the wanted display and restart capture if it moved or vanished.
    func displaysChanged() {
        q.async {
            guard self.running else { return }
            let before = self.display
            self.pickDisplay(notify: false)
            let d = self.display
            if d.id != before.id || d.pxW != before.pxW || d.pxH != before.pxH || d.ptsW != before.ptsW || d.ptsH != before.ptsH || d.originX != before.originX || d.originY != before.originY {
                self.link.sendJSON(["t": "display", "display": d.json, "displays": Displays.list(testPattern: self.testPattern).map { $0.json }])
                self.beginCapture()
            }
        }
    }

    private func pickDisplay(notify: Bool = true) {
        let list = Displays.list(testPattern: testPattern)
        display = list.first(where: { $0.id == cfg.displayID }) ?? list.first(where: { $0.main }) ?? list.first ?? display
        input.setDisplay(display)
        if notify { link.sendJSON(["t": "display", "display": display.json, "displays": list.map { $0.json }]) }
    }

    private func targetSize() -> (Int, Int) {
        var w = display.pxW, h = display.pxH
        if cfg.maxW > 0 && cfg.maxH > 0 {
            let s = min(1.0, min(Double(cfg.maxW) / Double(w), Double(cfg.maxH) / Double(h)))
            w = Int(Double(w) * s); h = Int(Double(h) * s)
        }
        return (max(2, w & ~1), max(2, h & ~1))
    }

    private func beginCapture() {
        retry?.cancel()
        source?.stop()
        encoder?.invalidate(); encoder = nil; encW = 0; encH = 0
        needKey = true
        lastPB = nil
        inflight = 0
        let (w, h) = targetSize()
        capW = w; capH = h
        if !testPattern && !CGPreflightScreenCaptureAccess() {
            fail("screen-recording-permission-missing"); return
        }
        lastError = nil
        let src: FrameSource = testPattern ? { let t = TestPatternSource(); t.input = testInput; return t }() : SCKSource()
        src.onFrame = { [weak self] pb in self?.q.async { self?.handleFrame(pb) } }
        src.onError = { [weak self] msg in self?.q.async { self?.fail(msg) } }
        source = src
        src.start(display: display, width: w, height: h, fps: cfg.fps)
        link.sendJSON(["t": "streamState", "on": true, "w": w, "h": h])
    }

    private func fail(_ msg: String) {
        lastError = msg
        link.sendJSON(["t": "streamError", "error": msg])
        guard running else { return }
        retry?.cancel()
        let w = DispatchWorkItem { [weak self] in
            guard let self = self, self.running else { return }
            self.pickDisplay()   // the display may have been unplugged since the failure
            self.beginCapture()
        }
        retry = w
        q.asyncAfter(deadline: .now() + 2.0, execute: w)
    }

    private func handleFrame(_ pb: CVPixelBuffer) {
        guard running else { return }
        lastPB = pb
        scheduleRefine()
        if inflight >= 3 && Date().timeIntervalSince(lastOut) < 0.5 { return } // pre-encode drop is safe
        encodeNow(pb)
    }

    /// Nothing is captured while the screen is static, so the last P-frame would stay at motion quality.
    /// 400 ms after the last change, resend that frame as a sharp keyframe (skipped if the link is busy).
    private func scheduleRefine() {
        refineItem?.cancel()
        let w = DispatchWorkItem { [weak self] in
            guard let self = self, self.running, self.inflight == 0, self.cfg.bitrate >= 2_500_000, let pb = self.lastPB, let enc = self.encoder else { return }   // slow-link levels skip refinement
            self.inflight += 1
            enc.refine(pb)
        }
        refineItem = w
        q.asyncAfter(deadline: .now() + 0.4, execute: w)
    }

    private func ensureEncoder(_ pb: CVPixelBuffer) -> Bool {
        let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb)
        if let _ = encoder, encW == w, encH == h, encCodec == cfg.codec { return true }
        encoder?.invalidate(); encoder = nil
        let e: FrameEncoder?
        if cfg.codec == "jpeg" { e = JPEGEncoder(quality: cfg.jpegQ) }
        else { e = H264Encoder(width: w, height: h, fps: cfg.fps, bitrate: cfg.bitrate) }
        guard let enc = e else { fail("encoder-create-failed"); return false }
        enc.onConfig = { [weak self] codec, avcC, w, h in
            self?.link.sendJSON(["t": "videoConfig", "codec": codec, "desc": avcC.base64EncodedString(), "w": w, "h": h])
        }
        enc.onFrame = { [weak self] f in self?.q.async { self?.emit(f) } }
        encoder = enc; encW = w; encH = h; encCodec = cfg.codec
        needKey = true
        return true
    }

    private func encodeNow(_ pb: CVPixelBuffer) {
        guard ensureEncoder(pb), let enc = encoder else { return }
        let force = needKey
        needKey = false
        inflight += 1
        enc.encode(pb, forceKey: force)
    }

    private func emit(_ f: EncodedFrame) {
        inflight = max(0, inflight - 1)
        lastOut = Date()
        seq &+= 1
        let ok = link.sendVideo(key: f.key, jpeg: f.jpeg, seq: seq, tsMicros: monotonicMicros(), data: f.data)
        if !ok && !f.key {   // a P-frame was dropped by the link: the decoder needs a fresh keyframe even if the screen is now static
            needKey = true
            if let pb = lastPB { encodeNow(pb) }
        }
    }
}
