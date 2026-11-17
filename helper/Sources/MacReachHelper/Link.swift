import Foundation
import Darwin

/// Unix-socket server speaking [1B type][4B BE len][payload] frames with the Node server.
/// Only one client at a time; a new connection replaces the old one.
final class Link {
    static let typeJSON: UInt8 = 1
    static let typeVideo: UInt8 = 2
    static let typeCommand: UInt8 = 0x10

    let path: String
    var onCommand: (([String: Any]) -> Void)?
    var onConnect: (() -> Void)?
    var onDisconnect: (() -> Void)?

    private var listenFD: Int32 = -1
    private var clientFD: Int32 = -1
    private let lock = NSLock()
    private let writeQ = DispatchQueue(label: "macreach.link.write")
    private var pendingBytes = 0
    private let maxPending = 6 * 1024 * 1024
    private(set) var connected = false

    init(path: String) { self.path = path }

    func start() throws {
        unlink(path)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw NSError(domain: "link", code: 1) }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { throw NSError(domain: "link", code: 2, userInfo: [NSLocalizedDescriptionKey: "socket path too long"]) }
        withUnsafeMutablePointer(to: &addr.sun_path) { p in
            p.withMemoryRebound(to: UInt8.self, capacity: bytes.count + 1) { dst in
                for (i, b) in bytes.enumerated() { dst[i] = b }
                dst[bytes.count] = 0
            }
        }
        let rc = withUnsafePointer(to: &addr) { p in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard rc == 0 else { throw NSError(domain: "link", code: 3, userInfo: [NSLocalizedDescriptionKey: "bind failed errno \(errno)"]) }
        chmod(path, 0o600)
        guard listen(fd, 2) == 0 else { throw NSError(domain: "link", code: 4) }
        listenFD = fd
        Thread.detachNewThread { [weak self] in self?.acceptLoop() }
    }

    private func acceptLoop() {
        while true {
            let c = accept(listenFD, nil, nil)
            if c < 0 { if errno == EINTR { continue }; usleep(200_000); continue }
            var one: Int32 = 1
            setsockopt(c, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
            lock.lock()
            let old = clientFD
            clientFD = c
            pendingBytes = 0
            connected = true
            lock.unlock()
            if old >= 0 { shutdown(old, SHUT_RDWR); close(old) }
            onConnect?()
            Thread.detachNewThread { [weak self] in self?.readLoop(fd: c) }
        }
    }

    private func readExact(_ fd: Int32, _ n: Int) -> Data? {
        var buf = Data(count: n)
        var got = 0
        let ok: Bool = buf.withUnsafeMutableBytes { raw in
            let base = raw.baseAddress!
            while got < n {
                let r = read(fd, base + got, n - got)
                if r > 0 { got += r } else if r < 0 && errno == EINTR { continue } else { return false }
            }
            return true
        }
        return ok ? buf : nil
    }

    private func readLoop(fd: Int32) {
        while true {
            guard let hdr = readExact(fd, 5) else { break }
            let type = hdr[0]
            let len = Int(hdr[1]) << 24 | Int(hdr[2]) << 16 | Int(hdr[3]) << 8 | Int(hdr[4])
            if len > 64 * 1024 * 1024 { break }
            guard let payload = len == 0 ? Data() : readExact(fd, len) else { break }
            if type == Link.typeCommand, let obj = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] {
                onCommand?(obj)
            }
        }
        lock.lock()
        let was = (clientFD == fd)
        if was { clientFD = -1; connected = false }
        lock.unlock()
        close(fd)
        if was { onDisconnect?() }
    }

    /// Returns false if dropped due to backlog.
    @discardableResult
    func send(type: UInt8, payload: Data, droppable: Bool = false) -> Bool {
        lock.lock()
        let fd = clientFD
        if fd < 0 { lock.unlock(); return false }
        if droppable && pendingBytes > maxPending { lock.unlock(); return false }
        pendingBytes += payload.count + 5
        lock.unlock()
        var frame = Data(capacity: payload.count + 5)
        frame.append(type)
        let n = UInt32(payload.count)
        frame.append(contentsOf: [UInt8(n >> 24 & 255), UInt8(n >> 16 & 255), UInt8(n >> 8 & 255), UInt8(n & 255)])
        frame.append(payload)
        writeQ.async { [weak self] in
            guard let self = self else { return }
            frame.withUnsafeBytes { raw in
                var off = 0
                while off < raw.count {
                    let r = write(fd, raw.baseAddress! + off, raw.count - off)
                    if r > 0 { off += r } else if r < 0 && (errno == EINTR || errno == EAGAIN) { usleep(1000) } else { break }
                }
            }
            self.lock.lock(); self.pendingBytes -= frame.count; self.lock.unlock()
        }
        return true
    }

    func sendJSON(_ obj: [String: Any]) {
        if let d = try? JSONSerialization.data(withJSONObject: obj) { send(type: Link.typeJSON, payload: d) }
    }

    func sendVideo(key: Bool, jpeg: Bool, seq: UInt32, tsMicros: UInt64, data: Data) -> Bool {
        var p = Data(capacity: data.count + 13)
        p.append((key ? 1 : 0) | (jpeg ? 2 : 0))
        p.append(contentsOf: [UInt8(seq >> 24 & 255), UInt8(seq >> 16 & 255), UInt8(seq >> 8 & 255), UInt8(seq & 255)])
        for i in (0..<8).reversed() { p.append(UInt8((tsMicros >> UInt64(i * 8)) & 255)) }
        p.append(data)
        return send(type: Link.typeVideo, payload: p, droppable: !key)
    }
}

func monotonicMicros() -> UInt64 {
    var info = mach_timebase_info_data_t()
    mach_timebase_info(&info)
    let t = mach_absolute_time()
    return t &* UInt64(info.numer) / UInt64(info.denom) / 1000
}
