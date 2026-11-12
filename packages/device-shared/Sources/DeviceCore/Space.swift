import Foundation

/// The coordinates of a session: what KOS was given (a display, or one
/// window) in points, scaled down to fit `maxEdge` on its long side and
/// never up.
///
/// A plain capture is exactly this size in pixels, so a point in the
/// picture KOS was shown is the point it clicks. Every mapping to the real
/// screen goes through here, so there is one place a click can land wrong.
public struct Space: Equatable, Sendable {
  /// What KOS was given, in global points, top-left origin (CoreGraphics' global space).
  public let display: Rect
  public let size: Size

  public init(display: Rect, maxEdge: Double = Limits.defaultMaxEdge) {
    self.display = display
    let longest = max(display.width, display.height)
    let factor = longest > maxEdge ? maxEdge / longest : 1
    size = Size(width: (display.width * factor).rounded(), height: (display.height * factor).rounded())
  }

  private init(display: Rect, size: Size) {
    self.display = display
    self.size = size
  }

  /// The same coordinates over a window that moved or was resized: a point
  /// KOS names still means the same place in the window.
  public func moved(to frame: Rect) -> Space {
    Space(display: frame, size: size)
  }

  private var scaleX: Double { size.width / display.width }
  private var scaleY: Double { size.height / display.height }

  /// A point KOS names, checked: inside the space, or a bad request saying where the space is.
  public func validate(_ p: Point) throws -> Point {
    guard p.x.isFinite, p.y.isFinite, Rect(x: 0, y: 0, width: size.width, height: size.height).contains(p) else {
      throw DeviceError.badRequest(
        "(\(Self.format(p.x)), \(Self.format(p.y))) is outside the picture, which is \(Self.format(size.width)) by \(Self.format(size.height)).")
    }
    return p
  }

  public func toGlobal(_ p: Point) -> Point {
    Point(x: display.x + p.x / scaleX, y: display.y + p.y / scaleY)
  }

  public func fromGlobal(_ p: Point) -> Point {
    Point(x: ((p.x - display.x) * scaleX * 10).rounded() / 10, y: ((p.y - display.y) * scaleY * 10).rounded() / 10)
  }

  /// A region KOS asked to read closer, as the part of the display it covers in global points.
  public func regionToGlobal(_ region: Rect) throws -> Rect {
    let whole = Rect(x: 0, y: 0, width: size.width, height: size.height)
    guard region.width > 0, region.height > 0, let inside = region.intersection(whole) else {
      throw DeviceError.badRequest("The region must have a size and overlap the screen.")
    }
    let origin = toGlobal(Point(x: inside.x, y: inside.y))
    return Rect(x: origin.x, y: origin.y, width: inside.width / scaleX, height: inside.height / scaleY)
  }

  /// The pixel size of a capture of `region` (global points): its full detail, down to `maxEdge`.
  public static func captureSize(of region: Rect, backingScale: Double, maxEdge: Double) -> Size {
    let width = region.width * backingScale
    let height = region.height * backingScale
    let longest = max(width, height)
    let factor = longest > maxEdge ? maxEdge / longest : 1
    return Size(width: max(1, (width * factor).rounded()), height: max(1, (height * factor).rounded()))
  }

  private static func format(_ v: Double) -> String {
    guard v.isFinite else { return "\(v)" }
    return String(format: v == v.rounded() ? "%.0f" : "%.1f", v)
  }
}
