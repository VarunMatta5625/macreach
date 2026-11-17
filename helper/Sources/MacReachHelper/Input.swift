import Foundation
import CoreGraphics
import AppKit
import ApplicationServices

struct InputSnapshot {
    var x = 0.5, y = 0.5
    var buttons = 0
    var scrollX = 0.0, scrollY = 0.0
    var keys: [String] = []
    var text = ""
    var clip = ""
}

protocol InputSink: AnyObject {
    func mouseMove(x: Double, y: Double)
    func mouseButton(button: Int, down: Bool, x: Double, y: Double, clicks: Int)
    func scroll(dx: Double, dy: Double)
    func key(code: String, down: Bool, repeatEvent: Bool)
    func text(_ s: String)
    func releaseAll()
    func setDisplay(_ d: DisplayInfo)
}

let keyCodes: [String: CGKeyCode] = [
    "KeyA": 0, "KeyS": 1, "KeyD": 2, "KeyF": 3, "KeyH": 4, "KeyG": 5, "KeyZ": 6, "KeyX": 7, "KeyC": 8, "KeyV": 9,
    "IntlBackslash": 10, "KeyB": 11, "KeyQ": 12, "KeyW": 13, "KeyE": 14, "KeyR": 15, "KeyY": 16, "KeyT": 17,
    "Digit1": 18, "Digit2": 19, "Digit3": 20, "Digit4": 21, "Digit6": 22, "Digit5": 23, "Equal": 24, "Digit9": 25,
    "Digit7": 26, "Minus": 27, "Digit8": 28, "Digit0": 29, "BracketRight": 30, "KeyO": 31, "KeyU": 32, "BracketLeft": 33,
    "KeyI": 34, "KeyP": 35, "Enter": 36, "KeyL": 37, "KeyJ": 38, "Quote": 39, "KeyK": 40, "Semicolon": 41,
    "Backslash": 42, "Comma": 43, "Slash": 44, "KeyN": 45, "KeyM": 46, "Period": 47, "Tab": 48, "Space": 49,
    "Backquote": 50, "Backspace": 51, "Escape": 53, "MetaRight": 54, "MetaLeft": 55, "ShiftLeft": 56, "CapsLock": 57,
    "AltLeft": 58, "ControlLeft": 59, "ShiftRight": 60, "AltRight": 61, "ControlRight": 62, "Fn": 63,
    "F17": 64, "NumpadDecimal": 65, "NumpadMultiply": 67, "NumpadAdd": 69, "NumLock": 71, "AudioVolumeUp": 72,
    "AudioVolumeDown": 73, "AudioVolumeMute": 74, "NumpadDivide": 75, "NumpadEnter": 76, "NumpadSubtract": 78,
    "F18": 79, "F19": 80, "NumpadEqual": 81, "Numpad0": 82, "Numpad1": 83, "Numpad2": 84, "Numpad3": 85,
    "Numpad4": 86, "Numpad5": 87, "Numpad6": 88, "Numpad7": 89, "Numpad8": 91, "Numpad9": 92, "IntlYen": 93,
    "IntlRo": 94, "F5": 96, "F6": 97, "F7": 98, "F3": 99, "F8": 100, "F9": 101, "F11": 103, "F13": 105, "F16": 106,
    "F14": 107, "F10": 109, "ContextMenu": 110, "F12": 111, "F15": 113, "Insert": 114, "Help": 114, "Home": 115,
    "PageUp": 116, "Delete": 117, "F4": 118, "End": 119, "F2": 120, "PageDown": 121, "F1": 122,
    "ArrowLeft": 123, "ArrowRight": 124, "ArrowDown": 125, "ArrowUp": 126,
]

private let modifierFlag: [String: CGEventFlags] = [
    "MetaLeft": .maskCommand, "MetaRight": .maskCommand,
    "ShiftLeft": .maskShift, "ShiftRight": .maskShift,
    "AltLeft": .maskAlternate, "AltRight": .maskAlternate,
    "ControlLeft": .maskControl, "ControlRight": .maskControl,
]
private let fnKeys: Set<String> = ["Home", "End", "PageUp", "PageDown", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
                                   "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12", "F13", "F14", "F15", "F16", "F17", "F18", "F19", "Insert", "Help"]
private let numpadKeys: Set<String> = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "NumpadDecimal", "NumpadMultiply", "NumpadAdd", "NumpadDivide",
                                        "NumpadEnter", "NumpadSubtract", "NumpadEqual", "Numpad0", "Numpad1", "Numpad2", "Numpad3", "Numpad4", "Numpad5", "Numpad6", "Numpad7", "Numpad8", "Numpad9"]

// MARK: - Real injection

final class CGInput: InputSink {
    private let src = CGEventSource(stateID: .hidSystemState)
    private let q = DispatchQueue(label: "macreach.input", qos: .userInteractive)
    private var display: DisplayInfo?
    private var held = Set<String>()          // held key codes (incl. modifiers)
    private var buttons = Set<Int>()
    private var capsOn = false
    private var lastPos = CGPoint.zero
    var invertScroll = false                  // flip if scroll direction is wrong

    func setDisplay(_ d: DisplayInfo) { q.async { self.display = d } }

    private var flags: CGEventFlags {
        var f = CGEventFlags()
        for k in held { if let m = modifierFlag[k] { f.insert(m) } }
        if capsOn { f.insert(.maskAlphaShift) }
        return f
    }

    private func point(_ x: Double, _ y: Double) -> CGPoint {
        guard let d = display else { return CGPoint(x: x * 1440, y: y * 900) }
        let cx = min(max(x, 0), 1), cy = min(max(y, 0), 1)
        let b = CGDisplayBounds(d.id)
        return CGPoint(x: b.origin.x + min(cx * b.width, b.width - 1), y: b.origin.y + min(cy * b.height, b.height - 1))
    }

    func mouseMove(x: Double, y: Double) {
        q.async {
            let p = self.point(x, y)
            let type: CGEventType = self.buttons.contains(0) ? .leftMouseDragged : self.buttons.contains(1) ? .rightMouseDragged : self.buttons.contains(2) ? .otherMouseDragged : .mouseMoved
            let btn: CGMouseButton = self.buttons.contains(1) ? .right : self.buttons.contains(2) ? .center : .left
            guard let e = CGEvent(mouseEventSource: self.src, mouseType: type, mouseCursorPosition: p, mouseButton: btn) else { return }
            e.flags = self.flags
            e.setIntegerValueField(.mouseEventDeltaX, value: Int64(p.x - self.lastPos.x))
            e.setIntegerValueField(.mouseEventDeltaY, value: Int64(p.y - self.lastPos.y))
            self.lastPos = p
            e.post(tap: .cghidEventTap)
        }
    }

    func mouseButton(button: Int, down: Bool, x: Double, y: Double, clicks: Int) {
        q.async {
            let p = self.point(x, y)
            let type: CGEventType
            let btn: CGMouseButton
            switch button {
            case 1: type = down ? .rightMouseDown : .rightMouseUp; btn = .right
            case 2: type = down ? .otherMouseDown : .otherMouseUp; btn = .center
            default: type = down ? .leftMouseDown : .leftMouseUp; btn = .left
            }
            if down { self.buttons.insert(button) } else { self.buttons.remove(button) }
            guard let e = CGEvent(mouseEventSource: self.src, mouseType: type, mouseCursorPosition: p, mouseButton: btn) else { return }
            e.flags = self.flags
            e.setIntegerValueField(.mouseEventClickState, value: Int64(max(1, clicks)))
            e.setIntegerValueField(.mouseEventButtonNumber, value: Int64(button == 1 ? 1 : button == 2 ? 2 : 0))
            self.lastPos = p
            e.post(tap: .cghidEventTap)
        }
    }

    func scroll(dx: Double, dy: Double) {
        q.async {
            // client sends content-direction deltas (positive dy = content moves up / reveals lower content).
            // CGEvent wheel positive = scroll up, so negate unless invertScroll.
            let sgn: Double = self.invertScroll ? 1 : -1
            guard let e = CGEvent(scrollWheelEvent2Source: self.src, units: .pixel, wheelCount: 2,
                                  wheel1: Int32((dy * sgn).rounded()), wheel2: Int32((dx * sgn).rounded()), wheel3: 0) else { return }
            e.flags = self.flags
            e.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
            e.post(tap: .cghidEventTap)
        }
    }

    func key(code: String, down: Bool, repeatEvent: Bool) {
        q.async {
            guard let vk = keyCodes[code] else { return }
            if code == "CapsLock" {
                if down { self.capsOn.toggle() }
                if let e = CGEvent(keyboardEventSource: self.src, virtualKey: vk, keyDown: down) { e.type = .flagsChanged; e.flags = self.flags; e.post(tap: .cghidEventTap) }
                return
            }
            let isMod = modifierFlag[code] != nil
            if down { self.held.insert(code) } else { self.held.remove(code) }
            guard let e = CGEvent(keyboardEventSource: self.src, virtualKey: vk, keyDown: down) else { return }
            var f = self.flags
            if fnKeys.contains(code) { f.insert(.maskSecondaryFn) }
            if numpadKeys.contains(code) { f.insert(.maskNumericPad) }
            e.flags = f
            if isMod { e.type = .flagsChanged }
            if repeatEvent && !isMod { e.setIntegerValueField(.keyboardEventAutorepeat, value: 1) }
            e.post(tap: .cghidEventTap)
        }
    }

    func text(_ s: String) {
        q.async {
            for ch in s {
                if ch == "\n" || ch == "\r" { self.tapRaw(36); continue }
                if ch == "\t" { self.tapRaw(48); continue }
                let units = Array(String(ch).utf16)
                guard let d = CGEvent(keyboardEventSource: self.src, virtualKey: 0, keyDown: true),
                      let u = CGEvent(keyboardEventSource: self.src, virtualKey: 0, keyDown: false) else { continue }
                d.flags = []; u.flags = []
                d.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                u.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                d.post(tap: .cghidEventTap); u.post(tap: .cghidEventTap)
            }
        }
    }

    private func tapRaw(_ vk: CGKeyCode) {
        CGEvent(keyboardEventSource: src, virtualKey: vk, keyDown: true)?.post(tap: .cghidEventTap)
        CGEvent(keyboardEventSource: src, virtualKey: vk, keyDown: false)?.post(tap: .cghidEventTap)
    }

    func releaseAll() {
        q.async {
            for k in self.held {
                guard let vk = keyCodes[k], let e = CGEvent(keyboardEventSource: self.src, virtualKey: vk, keyDown: false) else { continue }
                if modifierFlag[k] != nil { e.type = .flagsChanged }
                e.flags = []
                e.post(tap: .cghidEventTap)
            }
            self.held.removeAll()
            for b in self.buttons {
                let type: CGEventType = b == 1 ? .rightMouseUp : b == 2 ? .otherMouseUp : .leftMouseUp
                let btn: CGMouseButton = b == 1 ? .right : b == 2 ? .center : .left
                CGEvent(mouseEventSource: self.src, mouseType: type, mouseCursorPosition: self.lastPos, mouseButton: btn)?.post(tap: .cghidEventTap)
            }
            self.buttons.removeAll()
            self.capsOn = false
        }
    }
}

// MARK: - Test sink (records instead of injecting)

final class TestInput: InputSink {
    private var s = InputSnapshot()
    private let lock = NSLock()
    private var logPath: String?
    init(logPath: String?) { self.logPath = logPath; if let p = logPath { try? Data().write(to: URL(fileURLWithPath: p)) } }
    func snapshot() -> InputSnapshot { lock.lock(); defer { lock.unlock() }; return s }
    func setClip(_ t: String) { lock.lock(); s.clip = t; lock.unlock(); log(["ev": "clip", "text": t]) }
    private func log(_ o: [String: Any]) {
        guard let p = logPath, let d = try? JSONSerialization.data(withJSONObject: o), let fh = FileHandle(forWritingAtPath: p) else { return }
        fh.seekToEndOfFile(); fh.write(d); fh.write(Data("\n".utf8)); try? fh.close()
    }
    func mouseMove(x: Double, y: Double) { lock.lock(); s.x = x; s.y = y; lock.unlock(); log(["ev": "mm", "x": x, "y": y]) }
    func mouseButton(button: Int, down: Bool, x: Double, y: Double, clicks: Int) {
        lock.lock(); s.x = x; s.y = y
        if down { s.buttons |= 1 << button } else { s.buttons &= ~(1 << button) }
        lock.unlock(); log(["ev": down ? "md" : "mu", "b": button, "x": x, "y": y, "n": clicks])
    }
    func scroll(dx: Double, dy: Double) { lock.lock(); s.scrollX += dx; s.scrollY += dy; lock.unlock(); log(["ev": "wh", "dx": dx, "dy": dy]) }
    func key(code: String, down: Bool, repeatEvent: Bool) {
        lock.lock()
        if down { if !s.keys.contains(code) { s.keys.append(code) } } else { s.keys.removeAll { $0 == code } }
        lock.unlock(); log(["ev": down ? "kd" : "ku", "k": code, "rep": repeatEvent])
    }
    func text(_ t: String) { lock.lock(); s.text += t; lock.unlock(); log(["ev": "txt", "s": t]) }
    func releaseAll() { lock.lock(); s.keys = []; s.buttons = 0; lock.unlock(); log(["ev": "rel"]) }
    func setDisplay(_ d: DisplayInfo) {}
}
