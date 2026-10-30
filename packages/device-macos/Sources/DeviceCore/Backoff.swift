import Foundation

/// How long to wait before dialing KOS again: doubling from a second to half
/// a minute, with jitter so a host coming back is not met by every device at once.
public struct Backoff: Sendable {
  public static let first = 1.0
  public static let longest = 30.0
  /// How far either way a delay may drift, as a fraction of it.
  public static let jitter = 0.2

  private var attempt = 0

  public init() {}

  /// The next delay. `random` is a draw in 0...1, injected so tests can pin it.
  public mutating func next(random: Double = .random(in: 0...1)) -> TimeInterval {
    let base = min(Self.longest, Self.first * pow(2, Double(attempt)))
    attempt = min(attempt + 1, 16)
    return base * (1 - Self.jitter + 2 * Self.jitter * random)
  }

  public mutating func reset() {
    attempt = 0
  }
}
