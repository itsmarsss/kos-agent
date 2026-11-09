import AppKit
import DeviceUI

/// Notices the owner's own hand on the mouse or keyboard while KOS has the computer.
///
/// Events KOS posted are recognised by the injector and ignored. A click or
/// a key from anyone else is the owner taking over, at once. The pointer has
/// to travel as far as a deliberate move does first: a nudge, or a hand
/// coming off the trackpad, paused the very first live session a moment
/// after Allow. A scroll is reading along, not taking over, unless the owner
/// chose any move. For a few seconds after the owner hands control over
/// (Allow, Hand back) the pointer is not watched at all. What takes over is
/// the owner's choice (`Takeover`).
@MainActor
final class OwnerInputMonitor {
  private static let travelWindow: TimeInterval = 0.5

  private var takeover = Takeover.deliberate

  private var monitors: [Any] = []
  private var graceUntil = Date.distantPast
  private var travelled: CGFloat = 0
  private var travelStarted = Date.distantPast

  var onOwnerInput: (() -> Void)?
  /// Whether an event is KOS's own, posted by the injector.
  var isFromKOS: (CGEvent) -> Bool = { _ in false }

  func start(grace: TimeInterval, takeover: Takeover) {
    stop()
    self.takeover = takeover
    ignorePointer(for: grace)
    let mask: NSEvent.EventTypeMask = [
      .mouseMoved, .leftMouseDown, .rightMouseDown, .otherMouseDown,
      .leftMouseDragged, .rightMouseDragged, .scrollWheel, .keyDown,
    ]
    if let monitor = NSEvent.addGlobalMonitorForEvents(matching: mask, handler: { [weak self] event in
      MainActor.assumeIsolated { self?.handle(event) }
    }) {
      monitors.append(monitor)
    }
  }

  func stop() {
    monitors.forEach(NSEvent.removeMonitor)
    monitors.removeAll()
  }

  /// After the owner gives control back, their hand is still leaving the trackpad.
  func ignorePointer(for seconds: TimeInterval) {
    graceUntil = Date().addingTimeInterval(seconds)
    travelled = 0
  }

  private func handle(_ event: NSEvent) {
    if let raw = event.cgEvent, isFromKOS(raw) { return }
    switch event.type {
    case .scrollWheel:
      if takeover.scrollTakesOver { onOwnerInput?() }
    case .mouseMoved, .leftMouseDragged, .rightMouseDragged:
      guard let travel = takeover.travel else { return }
      let now = Date()
      guard now >= graceUntil else { return }
      if now.timeIntervalSince(travelStarted) > Self.travelWindow {
        travelStarted = now
        travelled = 0
      }
      travelled += hypot(event.deltaX, event.deltaY)
      if travelled >= travel { onOwnerInput?() }
    default:
      onOwnerInput?()
    }
  }
}
