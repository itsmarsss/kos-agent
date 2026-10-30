import AppKit

/// The overlay on the session's display: the border, KOS's cursor and its click ripples.
@MainActor
final class ScreenOverlay {
  let window: OverlayWindow
  private let displayFrame: CGRect
  private let border: GlowBorder
  private let cursor: KOSCursor
  private let stage = CALayer()

  /// The rounded corners of a MacBook's own screen, in points; other displays are square.
  private static let builtInCornerRadius: CGFloat = 10

  init(screen: NSScreen, display: CGDirectDisplayID) {
    displayFrame = CGDisplayBounds(display)
    window = OverlayWindow(frame: screen.frame)
    let view = NSView(frame: CGRect(origin: .zero, size: screen.frame.size))
    view.wantsLayer = true
    window.contentView = view
    border = GlowBorder(topCornerRadius: CGDisplayIsBuiltin(display) != 0 ? Self.builtInCornerRadius : 0)
    cursor = KOSCursor(contentsScale: screen.backingScaleFactor)
    stage.frame = view.bounds
    border.frame = view.bounds
    border.layoutIfNeeded()
    stage.addSublayer(border)
    stage.addSublayer(cursor)
    view.layer?.addSublayer(stage)
    cursor.move(to: local(Displays.cursor()))
  }

  func show() {
    window.alphaValue = 0
    window.orderFrontRegardless()
    window.fade(to: 1)
  }

  func hide(done: @escaping () -> Void) {
    window.fade(to: 0) { [window] in
      window.orderOut(nil)
      done()
    }
  }

  func setPaused(_ paused: Bool) {
    border.setPaused(paused)
    cursor.setPaused(paused)
  }

  func pointer(at global: CGPoint) {
    cursor.move(to: local(global))
  }

  func ripple(at global: CGPoint) {
    KOSCursor.ripple(at: local(global), in: stage)
  }

  func typing() {
    cursor.showTyping()
  }

  /// Wraps the border round one window (global, top-left) instead of the screen; nothing is the screen again.
  func focus(on window: CGRect?) {
    CATransaction.begin()
    CATransaction.setAnimationDuration(0.18)
    if let window {
      // Just outside the window's edge, so the light frames it rather than covering it.
      let outside = window.insetBy(dx: -3, dy: -3)
      let origin = local(CGPoint(x: outside.minX, y: outside.maxY))
      border.aroundWindow = true
      border.frame = CGRect(origin: origin, size: outside.size)
    } else {
      border.aroundWindow = false
      border.frame = stage.bounds
    }
    CATransaction.commit()
  }

  /// Whether a global point is on this overlay's display.
  func covers(_ global: CGPoint) -> Bool {
    displayFrame.contains(global)
  }

  /// A global point (top-left origin) in the overlay's layer space (bottom-left origin, this display).
  private func local(_ global: CGPoint) -> CGPoint {
    CGPoint(x: global.x - displayFrame.minX, y: displayFrame.height - (global.y - displayFrame.minY))
  }
}
