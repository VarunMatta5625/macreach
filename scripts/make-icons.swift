#!/usr/bin/env swift
// Draws the MacReach app icon (rounded square, monitor, cursor) and writes AppIcon.iconset for `iconutil`.
// Usage: swift scripts/make-icons.swift <iconset-dir> [<web-public-dir>]   (the second argument also writes the web app's icon-*.png)
import AppKit

func draw(_ px: Int) -> Data {
    let s = CGFloat(px)
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let ctx = NSGraphicsContext.current!.cgContext
    // macOS icon grid: art occupies ~80% of the canvas
    let inset = s * 0.1, body = NSRect(x: inset, y: inset, width: s - 2 * inset, height: s - 2 * inset)
    let bg = NSBezierPath(roundedRect: body, xRadius: body.width * 0.225, yRadius: body.width * 0.225)
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -s * 0.012), blur: s * 0.03, color: NSColor.black.withAlphaComponent(0.35).cgColor)
    NSColor(calibratedRed: 0.10, green: 0.14, blue: 0.40, alpha: 1).setFill(); bg.fill()
    ctx.restoreGState()
    NSGradient(colors: [NSColor(calibratedRed: 0.30, green: 0.52, blue: 1.0, alpha: 1), NSColor(calibratedRed: 0.42, green: 0.26, blue: 0.90, alpha: 1)])!.draw(in: bg, angle: -60)

    // monitor
    let mw = body.width * 0.60, mh = body.width * 0.40
    let mx = body.midX - mw / 2, my = body.midY - mh / 2 + body.width * 0.05
    let frame = NSBezierPath(roundedRect: NSRect(x: mx, y: my, width: mw, height: mh), xRadius: mw * 0.06, yRadius: mw * 0.06)
    NSColor.white.setFill(); frame.fill()
    let scr = NSBezierPath(roundedRect: NSRect(x: mx + mw * 0.035, y: my + mw * 0.035, width: mw * 0.93, height: mh - mw * 0.07), xRadius: mw * 0.035, yRadius: mw * 0.035)
    NSGradient(colors: [NSColor(calibratedRed: 0.13, green: 0.17, blue: 0.45, alpha: 1), NSColor(calibratedRed: 0.20, green: 0.16, blue: 0.55, alpha: 1)])!.draw(in: scr, angle: -70)
    // stand
    NSColor.white.setFill()
    NSBezierPath(rect: NSRect(x: body.midX - mw * 0.04, y: my - body.width * 0.075, width: mw * 0.08, height: body.width * 0.08)).fill()
    NSBezierPath(roundedRect: NSRect(x: body.midX - mw * 0.17, y: my - body.width * 0.095, width: mw * 0.34, height: body.width * 0.035), xRadius: mw * 0.017, yRadius: mw * 0.017).fill()

    // cursor on the screen
    let cx = mx + mw * 0.42, cy = my + mh * 0.62, u = mw * 0.20
    let cur = NSBezierPath()
    cur.move(to: NSPoint(x: cx, y: cy))
    cur.line(to: NSPoint(x: cx, y: cy - u * 1.45))
    cur.line(to: NSPoint(x: cx + u * 0.36, y: cy - u * 1.12))
    cur.line(to: NSPoint(x: cx + u * 0.62, y: cy - u * 1.68))
    cur.line(to: NSPoint(x: cx + u * 0.84, y: cy - u * 1.58))
    cur.line(to: NSPoint(x: cx + u * 0.58, y: cy - u * 1.04))
    cur.line(to: NSPoint(x: cx + u * 1.02, y: cy - u * 1.0))
    cur.close()
    NSColor.white.setFill(); cur.fill()
    NSColor(calibratedRed: 0.10, green: 0.14, blue: 0.40, alpha: 1).setStroke(); cur.lineWidth = max(1, u * 0.09); cur.lineJoinStyle = .round; cur.stroke()
    // signal arcs top-right of the monitor
    NSColor.white.setStroke()
    for i in 1...3 {
        let r = body.width * 0.05 * CGFloat(i), p = NSBezierPath()
        p.appendArc(withCenter: NSPoint(x: mx + mw * 0.98, y: my + mh * 1.02), radius: r, startAngle: 5, endAngle: 85)
        p.lineWidth = body.width * 0.022; p.lineCapStyle = .round; p.stroke()
    }
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon.iconset"
try FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
for (name, px) in [("16x16", 16), ("16x16@2x", 32), ("32x32", 32), ("32x32@2x", 64), ("128x128", 128), ("128x128@2x", 256), ("256x256", 256), ("256x256@2x", 512), ("512x512", 512), ("512x512@2x", 1024)] {
    try draw(px).write(to: URL(fileURLWithPath: "\(out)/icon_\(name).png"))
}
if CommandLine.arguments.count > 2 {
    let web = CommandLine.arguments[2]
    for px in [180, 192, 512] { try draw(px).write(to: URL(fileURLWithPath: "\(web)/icon-\(px).png")) }
}
