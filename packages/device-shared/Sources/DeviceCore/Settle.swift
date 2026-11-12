import Foundation

/// The picture after an action, once the screen has stopped changing.
///
/// KOS used to wait a fixed 450 ms before every picture, on its side of the
/// line, whether the click had changed anything or not. Here the device
/// looks again each beat and stops once two looks agree, up to the limit.
/// Two looks agreeing straight after an action says little: the app may not
/// have drawn its answer yet, and a menu that opened 100 ms later was missed.
/// So a match counts only once the screen has been seen to change, or once
/// `minimum` has passed with it still.
public enum Settle {
  /// The gap between two looks.
  public static let beat: Duration = .milliseconds(50)

  /// How long a screen that has not changed is given before it is taken as settled.
  public static let minimum: Duration = .milliseconds(120)

  /// Takes pictures until two in a row are the same, after a change or `minimum`, or `limit` has passed; gives back the last.
  /// `same` compares two pictures; `now` and `pause` are the clock, so a test can run it without waiting.
  public static func picture<Shot: Sendable>(
    limit: Duration,
    take: () async throws -> Shot,
    same: (Shot, Shot) -> Bool,
    now: () -> ContinuousClock.Instant = { ContinuousClock.now },
    pause: (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
  ) async throws -> Shot {
    let start = now()
    let end = start + limit
    var last = try await take()
    var changed = false
    while now() < end {
      try await pause(beat)
      let next = try await take()
      if same(last, next) {
        if changed || now() - start >= minimum { return next }
      } else {
        changed = true
      }
      last = next
    }
    return last
  }
}
