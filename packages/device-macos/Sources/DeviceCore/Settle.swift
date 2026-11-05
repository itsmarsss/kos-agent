import Foundation

/// The picture after an action, once the screen has stopped changing.
///
/// KOS used to wait a fixed 450 ms before every picture, on its side of the
/// line, whether the click had changed anything or not. Here the device
/// looks twice, a beat apart, and stops as soon as two looks agree: a click
/// that settles at once costs one beat, and one that sets something moving
/// waits for it, up to the same limit as before.
public enum Settle {
  /// The gap between two looks.
  public static let beat: Duration = .milliseconds(50)

  /// Takes pictures until two in a row are the same or `limit` has passed, and gives back the last.
  /// `same` compares two pictures; `now` and `pause` are the clock, so a test can run it without waiting.
  public static func picture<Shot: Sendable>(
    limit: Duration,
    take: () async throws -> Shot,
    same: (Shot, Shot) -> Bool,
    now: () -> ContinuousClock.Instant = { ContinuousClock.now },
    pause: (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
  ) async throws -> Shot {
    let end = now() + limit
    var last = try await take()
    while now() < end {
      try await pause(beat)
      let next = try await take()
      if same(last, next) { return next }
      last = next
    }
    return last
  }
}
