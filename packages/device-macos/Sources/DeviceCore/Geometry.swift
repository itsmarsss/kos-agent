import Foundation

/// A point, in whichever space the caller says. Plain doubles so the wire
/// format and the tests carry no CoreGraphics.
public struct Point: Codable, Equatable, Sendable {
  public var x: Double
  public var y: Double

  public init(x: Double, y: Double) {
    self.x = x
    self.y = y
  }

  public func distance(to other: Point) -> Double {
    hypot(other.x - x, other.y - y)
  }
}

public struct Size: Codable, Equatable, Sendable {
  public var width: Double
  public var height: Double

  public init(width: Double, height: Double) {
    self.width = width
    self.height = height
  }
}

public struct Rect: Codable, Equatable, Sendable {
  public var x: Double
  public var y: Double
  public var width: Double
  public var height: Double

  public init(x: Double, y: Double, width: Double, height: Double) {
    self.x = x
    self.y = y
    self.width = width
    self.height = height
  }

  public var maxX: Double { x + width }
  public var maxY: Double { y + height }

  /// Half-open on the far edges, so a screen of width 1512 holds x from 0 up to 1512.
  public func contains(_ p: Point) -> Bool {
    p.x >= x && p.y >= y && p.x < maxX && p.y < maxY
  }

  public func intersection(_ other: Rect) -> Rect? {
    let left = max(x, other.x)
    let top = max(y, other.y)
    let right = min(maxX, other.maxX)
    let bottom = min(maxY, other.maxY)
    guard right > left, bottom > top else { return nil }
    return Rect(x: left, y: top, width: right - left, height: bottom - top)
  }

  public func insetBy(_ amount: Double) -> Rect {
    Rect(x: x + amount, y: y + amount, width: width - 2 * amount, height: height - 2 * amount)
  }
}
