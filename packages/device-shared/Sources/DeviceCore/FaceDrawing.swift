import Foundation

/// A KOS's face as it sends it (docs/computer.md): its colours, its eyes,
/// its gait and its outline, decided in KOS so this app only draws it. Kept
/// as sent, so a KOS that is offline still looks like itself.
public struct FaceDrawing: Codable, Equatable, Sendable {
  public struct Lobe: Codable, Equatable, Sendable {
    public let k: Int
    public let amp: Double
    public let phase: Double
  }

  public struct Shape: Codable, Equatable, Sendable {
    public let aspect: Double
    public let squat: Double
    public let spread: Double
    public let lobes: [Lobe]
  }

  /// `#rrggbb`.
  public let fill: String
  public let ink: String
  /// `round`, `half` or `sparkle`.
  public let eyes: String
  /// 0 to 3.
  public let gait: Int
  public let shape: Shape

  /// Every part in range, as `readDrawing` in packages/shared checks it.
  public var isValid: Bool {
    Self.rgb(fill) != nil && Self.rgb(ink) != nil && ["round", "half", "sparkle"].contains(eyes) && (0...3).contains(gait)
      && (0.5...2).contains(shape.aspect) && (0...1).contains(shape.squat) && (0.5...2).contains(shape.spread)
      && shape.lobes.count <= 8
      && shape.lobes.allSatisfy { (1...8).contains($0.k) && (0...0.3).contains($0.amp) && (-10...10).contains($0.phase) }
  }

  /// A `#rrggbb` colour as one number, or nothing for anything else.
  public static func rgb(_ hex: String) -> UInt32? {
    guard hex.count == 7, hex.first == "#", hex.dropFirst().allSatisfy(\.isHexDigit) else { return nil }
    return UInt32(hex.dropFirst(), radix: 16)
  }
}
