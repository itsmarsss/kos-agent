import CoreGraphics

/// Where the chat window stands while KOS works this Mac: never over what KOS
/// works in. All in AppKit's screen points, bottom-left origin.
public enum ChatPlacement {
  /// The gap kept between the window and what KOS works in, and the screen's edge.
  public static let margin: CGFloat = 12

  /// Whether the window covers what a session works in: the window it shares, or, for the whole screen, its display.
  public static func covers(_ window: CGRect, target: CGRect) -> Bool {
    window.intersects(target)
  }

  /// Where the window's origin goes to stand clear of `target` on a screen whose usable area is `visible`: beside,
  /// above or below it, as near to where it is now as there is room. None when nowhere on that screen is clear, as
  /// when the whole of it is shared.
  public static func clear(of target: CGRect, window: CGRect, in visible: CGRect) -> CGPoint? {
    let size = window.size
    let area = visible.insetBy(dx: margin, dy: margin)
    guard area.width >= size.width, area.height >= size.height else { return nil }
    let x = min(max(window.minX, area.minX), area.maxX - size.width)
    let y = min(max(window.minY, area.minY), area.maxY - size.height)
    let candidates = [
      CGPoint(x: target.maxX + margin, y: y),
      CGPoint(x: target.minX - margin - size.width, y: y),
      CGPoint(x: x, y: target.maxY + margin),
      CGPoint(x: x, y: target.minY - margin - size.height),
    ]
    return candidates
      .filter { area.contains(CGRect(origin: $0, size: size)) && !CGRect(origin: $0, size: size).intersects(target) }
      .min { distance($0, window.origin) < distance($1, window.origin) }
  }

  /// Where the window goes on another screen when the one KOS works on has no room clear of it: the same corner of
  /// that screen as it had on its own, at the top right when it is new to it.
  public static func onAnother(_ visible: CGRect, window: CGRect, from: CGRect) -> CGPoint {
    let area = visible.insetBy(dx: margin, dy: margin)
    let right = window.midX >= from.midX
    let top = window.midY >= from.midY
    return CGPoint(
      x: right ? area.maxX - window.width : area.minX,
      y: top ? area.maxY - window.height : area.minY)
  }

  private static func distance(_ a: CGPoint, _ b: CGPoint) -> CGFloat {
    hypot(a.x - b.x, a.y - b.y)
  }
}

/// The chat window stepping aside for a session: put away when it would
/// cover what KOS works in, and back, without taking the front, when the
/// owner is needed (an approval, a take over) or the session ends; at the end
/// where it stood before the session, however it was moved for the owner.
public struct ChatAside: Equatable {
  public enum Event: Equatable {
    /// A session went live; `open` the window is up, `covers` it is over what KOS works in, `typing` the owner is
    /// typing in it, so it moves clear rather than going.
    case live(open: Bool, covers: Bool, typing: Bool = false)
    /// The turn waits on the owner, or they took the Mac over.
    case needsOwner
    /// The session ended.
    case ended
    /// The owner opened the window themselves.
    case opened
  }

  public enum Move: Equatable {
    case stay
    case hide
    /// Back where it was, or, while a session runs, clear of what KOS works in.
    case show(clear: Bool)
    /// Where it stood before the session, already up.
    case restore
  }

  /// The window is put away for the session, and comes back.
  public private(set) var aside = false
  /// It was moved clear of what KOS works in, and goes back where it stood once the session ends.
  public private(set) var moved = false

  public init() {}

  public mutating func take(_ event: Event) -> Move {
    switch event {
    case .live(let open, let covers, let typing):
      guard open, covers, !aside else { return .stay }
      // The owner is typing in it: it stays up, beside what KOS works in rather than over it.
      if typing {
        moved = true
        return .show(clear: true)
      }
      aside = true
      return .hide
    case .needsOwner:
      guard aside else { return .stay }
      aside = false
      moved = true
      return .show(clear: true)
    case .ended:
      defer {
        aside = false
        moved = false
      }
      if aside { return .show(clear: false) }
      return moved ? .restore : .stay
    case .opened:
      aside = false
      return .stay
    }
  }
}
