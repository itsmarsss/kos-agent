// Draws KOS Device's icon into an .iconset folder: KOS's cursor, lit, on a deep blue tile.
// Usage: swift scripts/icon.swift <out.iconset>
import AppKit

let out = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? "AppIcon.iconset")
try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

let accent = NSColor(srgbRed: 0x7C / 255, green: 0x9C / 255, blue: 0xFF / 255, alpha: 1)
let violet = NSColor(srgbRed: 0xA5 / 255, green: 0x7C / 255, blue: 0xFF / 255, alpha: 1)
let night = NSColor(srgbRed: 0x0C / 255, green: 0x0E / 255, blue: 0x12 / 255, alpha: 1)

func draw(_ side: CGFloat) -> Data? {
  let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: Int(side), pixelsHigh: Int(side), bitsPerSample: 8, samplesPerPixel: 4,
    hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  let tile = CGRect(x: side * 0.1, y: side * 0.1, width: side * 0.8, height: side * 0.8)
  let shape = NSBezierPath(roundedRect: tile, xRadius: side * 0.18, yRadius: side * 0.18)
  NSGradient(starting: NSColor(srgbRed: 0.10, green: 0.12, blue: 0.22, alpha: 1), ending: night)!.draw(in: shape, angle: -90)
  // The glowing rim, as round the screen in a session: a soft bloom, then a crisp gradient line.
  let ctx = NSGraphicsContext.current!.cgContext
  let rimRect = tile.insetBy(dx: side * 0.03, dy: side * 0.03)
  let rim = CGPath(roundedRect: rimRect, cornerWidth: side * 0.15, cornerHeight: side * 0.15, transform: nil)
  ctx.saveGState()
  ctx.setShadow(offset: .zero, blur: side * 0.06, color: accent.cgColor)
  ctx.setStrokeColor(accent.withAlphaComponent(0.8).cgColor)
  ctx.setLineWidth(side * 0.02)
  ctx.addPath(rim)
  ctx.strokePath()
  ctx.restoreGState()
  ctx.saveGState()
  ctx.addPath(rim)
  ctx.setLineWidth(side * 0.014)
  ctx.replacePathWithStrokedPath()
  ctx.clip()
  let colours = [accent.cgColor, violet.cgColor] as CFArray
  let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: colours, locations: [0, 1])!
  ctx.drawLinearGradient(gradient, start: CGPoint(x: rimRect.minX, y: rimRect.minY), end: CGPoint(x: rimRect.maxX, y: rimRect.maxY), options: [])
  ctx.restoreGState()
  // KOS's cursor.
  let points: [CGPoint] = [(0, 0), (0, 17), (4.2, 13.3), (7, 19.5), (9.6, 18.4), (6.9, 12.3), (12.5, 12.3)].map { CGPoint(x: $0.0, y: $0.1) }
  let scale = side * 0.4 / 20
  let origin = CGPoint(x: side * 0.38, y: side * 0.72)
  let arrow = NSBezierPath()
  for (i, p) in points.enumerated() {
    let q = CGPoint(x: origin.x + p.x * scale, y: origin.y - p.y * scale)
    if i == 0 { arrow.move(to: q) } else { arrow.line(to: q) }
  }
  arrow.close()
  arrow.lineJoinStyle = .round
  arrow.lineWidth = side * 0.02
  NSGraphicsContext.current?.saveGraphicsState()
  let lit = NSShadow()
  lit.shadowColor = accent
  lit.shadowBlurRadius = side * 0.06
  lit.set()
  accent.setFill()
  arrow.fill()
  NSGraphicsContext.current?.restoreGraphicsState()
  NSColor.white.setStroke()
  arrow.stroke()
  NSGraphicsContext.restoreGraphicsState()
  return rep.representation(using: .png, properties: [:])
}

for points in [16, 32, 128, 256, 512] {
  for scale in [1, 2] {
    let name = scale == 1 ? "icon_\(points)x\(points).png" : "icon_\(points)x\(points)@2x.png"
    try draw(CGFloat(points * scale))?.write(to: out.appendingPathComponent(name))
  }
}
