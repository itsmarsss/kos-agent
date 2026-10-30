import AppKit

/// Everything the owner sees while KOS has the computer: the border and
/// KOS's cursor on the session's display, and the bar with Pause and Stop.
/// Up for the whole session and gone when it ends.
@MainActor
final class OverlayController {
  var onPause: (() -> Void)?
  var onResume: (() -> Void)?
  var onStop: (() -> Void)?
  var onExtend: (() -> Void)?

  private var screen: ScreenOverlay?
  private var hud: HUDPanel?

  /// `window`, when given, is what the border wraps; the overlay is on the display it is on.
  func show(display: CGDirectDisplayID, task: String, until: Date, window: CGRect? = nil) {
    hide()
    guard let nsScreen = Displays.screen(for: display) else { return }
    let overlay = ScreenOverlay(screen: nsScreen, display: display)
    let bar = HUDPanel(
      screen: nsScreen, task: task, until: until,
      pause: { [weak self] in self?.onPause?() },
      resume: { [weak self] in self?.onResume?() },
      stop: { [weak self] in self?.onStop?() },
      extend: { [weak self] in self?.onExtend?() })
    overlay.focus(on: window)
    overlay.show()
    bar.alphaValue = 0
    bar.orderFrontRegardless()
    bar.fade(to: 1)
    screen = overlay
    hud = bar
  }

  func hide() {
    if let overlay = screen {
      overlay.hide {}
    }
    if let bar = hud {
      bar.fade(to: 0) { bar.orderOut(nil) }
    }
    screen = nil
    hud = nil
  }

  func setPaused(_ paused: Bool) {
    screen?.setPaused(paused)
    hud?.setPaused(paused)
  }

  func setUntil(_ until: Date) {
    hud?.setUntil(until)
  }

  /// The window moved: the border follows it. False when it is off this display now, for the overlay to move.
  func follow(window frame: CGRect) -> Bool {
    guard let screen, screen.covers(CGPoint(x: frame.midX, y: frame.midY)) else { return false }
    screen.focus(on: frame)
    return true
  }

  func pointer(at global: CGPoint) {
    screen?.pointer(at: global)
  }

  func ripple(at global: CGPoint) {
    screen?.ripple(at: global)
  }

  func typing() {
    screen?.typing()
  }

  /// Gets the bar out from under the points KOS is about to use, and waits for it to move.
  func clear(_ points: [CGPoint]) async {
    guard let hud, points.contains(where: { hud.dodge($0) }) else { return }
    try? await Task.sleep(nanoseconds: 250_000_000)
  }
}
