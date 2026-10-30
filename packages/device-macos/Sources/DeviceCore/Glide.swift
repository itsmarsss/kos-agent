import Foundation

/// The path KOS's pointer travels between two points.
///
/// A pointer that jumps is a pointer the owner cannot follow. This one eases
/// out and in along a shallow arc, quicker for short hops, and is sampled at
/// the rate the app posts motion events, so the owner watches it go there.
public struct Glide: Equatable, Sendable {
  public let points: [Point]
  /// Seconds between consecutive points.
  public let interval: Double

  public static let rate = 120.0
  public static let shortest = 0.15
  public static let longest = 0.45
  /// The distance, in points, at which a glide takes the longest time.
  public static let farDistance = 1500.0

  public static func duration(for distance: Double) -> Double {
    guard distance > 0 else { return 0 }
    return shortest + (longest - shortest) * min(1, distance / farDistance)
  }

  /// The points after `from`, ending exactly on `to`.
  public init(from: Point, to: Point, rate: Double = Glide.rate) {
    interval = 1 / rate
    let distance = from.distance(to: to)
    let steps = Int((Self.duration(for: distance) * rate).rounded())
    guard steps > 1 else {
      points = [to]
      return
    }
    // A control point off to one side of the straight line bends it into a
    // shallow arc, as a hand moving a mouse does.
    let bend = min(40, distance * 0.06)
    let mid = Point(x: (from.x + to.x) / 2, y: (from.y + to.y) / 2)
    let normal = Point(x: -(to.y - from.y) / distance, y: (to.x - from.x) / distance)
    let control = Point(x: mid.x + normal.x * bend, y: mid.y + normal.y * bend)
    points = (1...steps).map { step in
      if step == steps { return to }
      let t = Self.ease(Double(step) / Double(steps))
      let u = 1 - t
      return Point(
        x: u * u * from.x + 2 * u * t * control.x + t * t * to.x,
        y: u * u * from.y + 2 * u * t * control.y + t * t * to.y)
    }
  }

  /// Cubic ease in and out: slow off the mark, quick in the middle, settling at the end.
  static func ease(_ t: Double) -> Double {
    t < 0.5 ? 4 * t * t * t : 1 - pow(-2 * t + 2, 3) / 2
  }
}
