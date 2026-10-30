import AppKit

/// Notices the owner's own hand on the mouse or keyboard while KOS has the computer.
///
/// Events KOS posted are recognised by the injector and ignored. A click, a
/// scroll or a key from anyone else is the owner taking over, at once. The
/// pointer has to travel as far as a deliberate move does first: a nudge,
/// or a hand coming off the trackpad, paused the very first live session a
/// moment after Allow. And for a few seconds after the owner hands control
/// over (Allow, Resume) the pointer is not watched at all.
@MainActor
final class OwnerInputMonitor {
  private static let travel: CGFloat = 40
  private static let travelWindow: TimeInterval = 0.5

  private var monitors: [Any] = []
  private var graceUntil = Date.distantPast
  private var travelled: CGFloat = 0
  private var travelStarted = Date.distantPast

  var onOwnerInput: (() -> Void)?
  /// Whether an event is KOS's own, posted by the injector.
  var isFromKOS: (CGEvent) -> Bool = { _ in false }

  func start(grace: TimeInterval) {
    stop()
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
    case .mouseMoved, .leftMouseDragged, .rightMouseDragged:
      let now = Date()
      guard now >= graceUntil else { return }
      if now.timeIntervalSince(travelStarted) > Self.travelWindow {
        travelStarted = now
        travelled = 0
      }
      travelled += hypot(event.deltaX, event.deltaY)
      if travelled >= Self.travel { onOwnerInput?() }
    default:
      onOwnerInput?()
    }
  }
}
