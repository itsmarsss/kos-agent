import AppKit

/// A window that floats over everything, on every space and over full-screen apps, and never takes a click.
final class OverlayWindow: NSWindow {
  init(frame: CGRect) {
    super.init(contentRect: frame, styleMask: .borderless, backing: .buffered, defer: false)
    isOpaque = false
    backgroundColor = .clear
    hasShadow = false
    ignoresMouseEvents = true
    isReleasedWhenClosed = false
    level = .screenSaver
    collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    // Kept out of other apps' screen shares and recordings too, not only out of KOS's captures.
    sharingType = .none
    animationBehavior = .none
  }

  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

extension NSWindow {
  /// Fades to `alpha`, then runs `done`.
  func fade(to alpha: CGFloat, duration: TimeInterval = 0.35, done: (() -> Void)? = nil) {
    NSAnimationContext.runAnimationGroup({ context in
      context.duration = duration
      context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
      animator().alphaValue = alpha
    }, completionHandler: done)
  }
}
