import AppKit
import SwiftUI

/// KOS's face, alive: the dashboard's blob, drawn every frame from BlobMotion.
///
/// It looks at the pointer wherever it is on the screen, squashes when the
/// pointer is over it, and wobbles, pleased, when it is clicked. With Reduce
/// Motion on it holds still.
public struct KOSFace: View {
  private let size: CGFloat
  private let mood: BlobMood
  @StateObject private var driver = BlobDriver()
  @Environment(\.accessibilityReduceMotion) private var still

  public init(size: CGFloat = 40, mood: BlobMood = .idle) {
    self.size = size
    self.mood = mood
  }

  public var body: some View {
    TimelineView(.animation(paused: still)) { context in
      let frame = driver.frame(at: context.date.timeIntervalSinceReferenceDate, mood: mood, still: still)
      Canvas { canvas, area in Self.draw(frame, in: &canvas, size: area.width) }
    }
    .frame(width: size, height: size)
    .background(PointerProbe(driver: driver))
    .onHover { driver.hover = $0 }
    .onTapGesture { driver.poke() }
    .accessibilityHidden(true)
  }

  private static let body = Color(hex: 0x3585ED)
  private static let ink = Color(hex: 0x141D29)

  private static func draw(_ frame: BlobFrame, in canvas: inout GraphicsContext, size: CGFloat) {
    let c = BlobMotion.center
    let group = CGAffineTransform(translationX: -c.x, y: -c.y)
      .concatenating(CGAffineTransform(a: 1, b: 0, c: tan(frame.skew * .pi / 180), d: 1, tx: 0, ty: 0))
      .concatenating(CGAffineTransform(scaleX: frame.scaleX, y: frame.scaleY))
      .concatenating(CGAffineTransform(translationX: c.x + frame.lean, y: c.y + frame.lift))
      .concatenating(CGAffineTransform(scaleX: size / 100, y: size / 100))
    canvas.fill(smooth(frame.outline).applying(group), with: .color(body))

    for (index, base) in [BlobMotion.eyeLeft, BlobMotion.eyeRight].enumerated() {
      let at = BlobMotion.eye(base)
      let slant = index == 0 ? frame.slant : -frame.slant
      let place = CGAffineTransform(scaleX: frame.wide, y: frame.happy ? frame.wide : frame.wide * frame.open)
        .concatenating(CGAffineTransform(rotationAngle: slant * .pi / 180))
        .concatenating(CGAffineTransform(translationX: at.x + frame.lookX, y: at.y + frame.lookY))
        .concatenating(group)
      if frame.happy {
        // Pleased: the eyes become arcs, the way a face with no mouth smiles.
        var grin = Path()
        grin.move(to: CGPoint(x: -3.8, y: 1.4))
        grin.addQuadCurve(to: CGPoint(x: 3.8, y: 1.4), control: CGPoint(x: 0, y: -3.4))
        canvas.stroke(grin.applying(place), with: .color(ink), style: StrokeStyle(lineWidth: 2.4 * size / 100, lineCap: .round))
      } else {
        let pill = Path(roundedRect: CGRect(x: -2.7, y: -4.8, width: 5.4, height: 9.6), cornerRadius: 2.7)
        canvas.fill(pill.applying(place), with: .color(ink))
      }
    }
  }

  /// A closed Catmull-Rom curve through the points, as cubic Béziers, so no corner ever shows.
  private static func smooth(_ pts: [CGPoint]) -> Path {
    var path = Path()
    guard let first = pts.first else { return path }
    let n = pts.count
    path.move(to: first)
    for i in 0..<n {
      let p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n]
      path.addCurve(
        to: p2,
        control1: CGPoint(x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6),
        control2: CGPoint(x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6))
    }
    path.closeSubpath()
    return path
  }
}

/// The motion between frames, and the pointer as the face sees it.
@MainActor
final class BlobDriver: ObservableObject {
  private var motion = BlobMotion(now: Date.timeIntervalSinceReferenceDate)
  private var last: TimeInterval?
  private var pointerAt: TimeInterval = -.infinity
  private var lastPointer: CGPoint?
  weak var view: NSView?

  var hover: Bool {
    get { motion.hover }
    set { motion.hover = newValue }
  }

  func poke() {
    motion.poke(now: Date.timeIntervalSinceReferenceDate)
  }

  func frame(at now: TimeInterval, mood: BlobMood, still: Bool) -> BlobFrame {
    motion.mood = mood
    let dt = last.map { now - $0 } ?? 0.016
    last = now
    return motion.step(now: now, dt: still ? 0.016 : dt, pointer: still ? nil : pointer(now: now))
  }

  /// Where the pointer is from the face's centre, y down, while it has moved in the last few seconds.
  private func pointer(now: TimeInterval) -> CGVector? {
    guard let view, let window = view.window else { return nil }
    let screenPoint = NSEvent.mouseLocation
    if screenPoint != lastPointer {
      lastPointer = screenPoint
      pointerAt = now
    }
    guard now - pointerAt < 6 else { return nil }
    let inView = view.convert(window.convertPoint(fromScreen: screenPoint), from: nil)
    let dy = view.isFlipped ? inView.y - view.bounds.midY : view.bounds.midY - inView.y
    return CGVector(dx: inView.x - view.bounds.midX, dy: dy)
  }
}

/// An empty view behind the face, so the driver can ask where the face is on the screen.
private struct PointerProbe: NSViewRepresentable {
  let driver: BlobDriver

  func makeNSView(context: Context) -> NSView {
    let view = NSView()
    driver.view = view
    return view
  }

  func updateNSView(_ nsView: NSView, context: Context) {
    driver.view = nsView
  }
}
