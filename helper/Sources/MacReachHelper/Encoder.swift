import Foundation
import VideoToolbox
import CoreImage
import CoreMedia

struct EncodedFrame {
    var data: Data
    var key: Bool
    var jpeg: Bool
}

protocol FrameEncoder: AnyObject {
    var onFrame: ((EncodedFrame) -> Void)? { get set }
    var onConfig: ((_ codec: String, _ avcC: Data, _ w: Int, _ h: Int) -> Void)? { get set }
    func encode(_ pb: CVPixelBuffer, forceKey: Bool)
    /// Re-encode a still frame at higher quality (called when the screen stopped changing).
    func refine(_ pb: CVPixelBuffer)
    func setRate(bitrate: Int, fps: Int)
    func invalidate()
}

final class H264Encoder: FrameEncoder {
    var onFrame: ((EncodedFrame) -> Void)?
    var onConfig: ((String, Data, Int, Int) -> Void)?
    private var session: VTCompressionSession?
    private let width: Int, height: Int
    private var fps: Int
    private var bitrate: Int
    private var lastCodec = ""
    private var frameCounter: Int64 = 0

    init?(width: Int, height: Int, fps: Int, bitrate: Int) {
        self.width = width; self.height = height; self.fps = fps; self.bitrate = bitrate
        var s: VTCompressionSession?
        let spec: [CFString: Any] = [kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: true]
        let st = VTCompressionSessionCreate(allocator: nil, width: Int32(width), height: Int32(height),
                                            codecType: kCMVideoCodecType_H264, encoderSpecification: spec as CFDictionary,
                                            imageBufferAttributes: nil, compressedDataAllocator: nil,
                                            outputCallback: nil, refcon: nil, compressionSessionOut: &s)
        guard st == noErr, let sess = s else { return nil }
        session = sess
        func set(_ k: CFString, _ v: Any) { VTSessionSetProperty(sess, key: k, value: v as CFTypeRef) }
        set(kVTCompressionPropertyKey_RealTime, kCFBooleanTrue!)
        set(kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse!)
        set(kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_High_AutoLevel)
        set(kVTCompressionPropertyKey_H264EntropyMode, kVTH264EntropyMode_CABAC)
        set(kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality, kCFBooleanTrue!)
        set(kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, 30)
        set(kVTCompressionPropertyKey_MaxKeyFrameInterval, 100000)
        set(kVTCompressionPropertyKey_MaxFrameDelayCount, 0)
        set(kVTCompressionPropertyKey_ColorPrimaries, kCVImageBufferColorPrimaries_ITU_R_709_2)
        set(kVTCompressionPropertyKey_TransferFunction, kCVImageBufferTransferFunction_ITU_R_709_2)
        set(kVTCompressionPropertyKey_YCbCrMatrix, kCVImageBufferYCbCrMatrix_ITU_R_709_2)
        applyRate()
        VTCompressionSessionPrepareToEncodeFrames(sess)
    }

    private func applyRate() {
        guard let sess = session else { return }
        VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: fps as CFTypeRef)
        VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_AverageBitRate, value: bitrate as CFTypeRef)
        // cap: at most ~2x average over 1s window (keyframes are big)
        let limits: [Int] = [max(bitrate / 8 * 2, 50_000), 1]
        VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_DataRateLimits, value: limits as CFArray)
    }

    func setRate(bitrate: Int, fps: Int) {
        self.bitrate = bitrate; self.fps = fps
        applyRate()
    }

    func encode(_ pb: CVPixelBuffer, forceKey: Bool) {
        guard let sess = session else { return }
        frameCounter += 1
        let pts = CMTime(value: Int64(monotonicMicros()), timescale: 1_000_000)
        let props: CFDictionary? = forceKey ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
        VTCompressionSessionEncodeFrame(sess, imageBuffer: pb, presentationTimeStamp: pts, duration: .invalid,
                                        frameProperties: props, infoFlagsOut: nil) { [weak self] status, _, sample in
            guard let self = self, status == noErr, let sample = sample else { return }
            self.handle(sample)
        }
    }

    func refine(_ pb: CVPixelBuffer) {
        guard let sess = session else { return }
        let boosted = min(bitrate * (bitrate < 6_000_000 ? 2 : 4), 40_000_000)
        VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_AverageBitRate, value: boosted as CFTypeRef)
        VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_DataRateLimits, value: [boosted / 8 * 4, 1] as CFArray)
        encode(pb, forceKey: true)
        VTCompressionSessionCompleteFrames(sess, untilPresentationTimeStamp: .invalid)
        applyRate()
    }

    private func handle(_ sample: CMSampleBuffer) {
        guard let block = CMSampleBufferGetDataBuffer(sample) else { return }
        var key = true
        if let atts = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]], let a = atts.first {
            if let ns = a[kCMSampleAttachmentKey_NotSync] as? Bool, ns { key = false }
        }
        if key, let fmt = CMSampleBufferGetFormatDescription(sample) {
            if let avcC = Self.avcC(from: fmt) {
                let codec = String(format: "avc1.%02x%02x%02x", avcC[1], avcC[2], avcC[3])
                onConfig?(codec, avcC, width, height)
                lastCodec = codec
            }
        }
        var len = 0
        var ptr: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &len, dataPointerOut: &ptr) == noErr, let p = ptr else { return }
        onFrame?(EncodedFrame(data: Data(bytes: p, count: len), key: key, jpeg: false))
    }

    static func avcC(from fmt: CMFormatDescription) -> Data? {
        if let ext = CMFormatDescriptionGetExtension(fmt, extensionKey: kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms) as? [String: Any],
           let d = ext["avcC"] as? Data, d.count > 7 { return d }
        // manual fallback
        var spsPtr: UnsafePointer<UInt8>?, ppsPtr: UnsafePointer<UInt8>?
        var spsLen = 0, ppsLen = 0
        guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: 0, parameterSetPointerOut: &spsPtr, parameterSetSizeOut: &spsLen, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr,
              CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: 1, parameterSetPointerOut: &ppsPtr, parameterSetSizeOut: &ppsLen, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr,
              let sps = spsPtr, let pps = ppsPtr, spsLen >= 4 else { return nil }
        var d = Data([1, sps[1], sps[2], sps[3], 0xFF, 0xE1, UInt8(spsLen >> 8), UInt8(spsLen & 255)])
        d.append(sps, count: spsLen)
        d.append(contentsOf: [1, UInt8(ppsLen >> 8), UInt8(ppsLen & 255)])
        d.append(pps, count: ppsLen)
        if [100, 110, 122, 244].contains(Int(sps[0 + 1])) { d.append(contentsOf: [0xFD, 0xF8, 0xF8, 0]) }
        return d
    }

    func invalidate() {
        if let s = session { VTCompressionSessionCompleteFrames(s, untilPresentationTimeStamp: .invalid); VTCompressionSessionInvalidate(s) }
        session = nil
    }
    deinit { invalidate() }
}

final class JPEGEncoder: FrameEncoder {
    var onFrame: ((EncodedFrame) -> Void)?
    var onConfig: ((String, Data, Int, Int) -> Void)?
    var quality: Double
    private let ctx = CIContext(options: [.cacheIntermediates: false])
    private let cs = CGColorSpace(name: CGColorSpace.sRGB)!
    private var announced = false
    init(quality: Double) { self.quality = quality }
    func encode(_ pb: CVPixelBuffer, forceKey: Bool) {
        if !announced {
            announced = true
            onConfig?("jpeg", Data(), CVPixelBufferGetWidth(pb), CVPixelBufferGetHeight(pb))
        }
        let img = CIImage(cvPixelBuffer: pb)
        let opts: [CIImageRepresentationOption: Any] = [CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): quality]
        if let d = ctx.jpegRepresentation(of: img, colorSpace: cs, options: opts) {
            onFrame?(EncodedFrame(data: d, key: true, jpeg: true))
        }
    }
    func refine(_ pb: CVPixelBuffer) {
        let q = quality; quality = max(q, 0.92)
        encode(pb, forceKey: true)
        quality = q
    }
    func setRate(bitrate: Int, fps: Int) {
        // map bitrate to quality loosely
        quality = min(0.9, max(0.3, Double(bitrate) / 10_000_000.0))
    }
    func invalidate() {}
}
