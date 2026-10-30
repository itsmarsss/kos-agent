import AppKit
import DeviceUI
import SwiftUI

/// The bar at the top of the screen: KOS is using this Mac, for what, with Pause and Stop.
///
/// A non-activating panel, so pressing its buttons never takes focus from
/// the app KOS is working in. It keeps out of KOS's way: before KOS points
/// anywhere under it, the bar moves to the other edge of the screen.
@MainActor
final class HUDPanel: NSPanel {
  private let bar: SessionBarModel
  private let screenFrame: CGRect
  private let visibleFrame: CGRect
  private(set) var atBottom = false

  init(screen: NSScreen, task text: String, pause: @escaping () -> Void, resume: @escaping () -> Void, stop: @escaping () -> Void) {
    screenFrame = screen.frame
    visibleFrame = screen.visibleFrame
    bar = SessionBarModel(task: text)
    bar.pause = pause
    bar.resume = resume
    bar.stop = stop
    let host = FirstClickHost(rootView: SessionBar(model: bar))
    super.init(contentRect: CGRect(origin: .zero, size: host.fittingSize), styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: false)
    isFloatingPanel = true
    becomesKeyOnlyIfNeeded = true
    hidesOnDeactivate = false
    isOpaque = false
    backgroundColor = .clear
    hasShadow = false
    isReleasedWhenClosed = false
    level = NSWindow.Level(rawValue: NSWindow.Level.screenSaver.rawValue + 1)
    collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    appearance = NSAppearance(named: .darkAqua)
    contentView = host
    place(bottom: false, animated: false)
  }

  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }

  func setPaused(_ paused: Bool) {
    bar.paused = paused
  }

  /// Moves to the other edge when `global` (top-left origin) falls under the bar or near it.
  /// True when it moved, so the caller can let the move land before pointing there.
  func dodge(_ global: CGPoint) -> Bool {
    let mine = Displays.cocoa(frame).insetBy(dx: -12, dy: -12)
    guard mine.contains(global) else { return false }
    place(bottom: !atBottom, animated: true)
    return true
  }

  private func place(bottom: Bool, animated: Bool) {
    atBottom = bottom
    // The bar's own padding keeps it, and its glow, off the screen's edge.
    let size = frame.size
    let y = bottom ? visibleFrame.minY : visibleFrame.maxY - size.height
    setFrame(CGRect(x: screenFrame.midX - size.width / 2, y: y, width: size.width, height: size.height), display: true, animate: animated)
  }
}

/// A hosting view that answers the first click, in a panel that never becomes key.
private final class FirstClickHost<Content: View>: NSHostingView<Content> {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}
