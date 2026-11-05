import Foundation
import Testing

@testable import DeviceCore

/// The picture after an action is taken once two looks a beat apart agree, after a change or the minimum, and never later than the limit.
@Suite("Settle")
struct SettleTests {
  /// A clock that moves only when the settle pauses, and screens taken in turn.
  final class Fake: @unchecked Sendable {
    var screens: [Int]
    var taken = 0
    let start = ContinuousClock.now
    var at = ContinuousClock.now
    /// The screen as a function of the time since the action, when it is given one.
    var when: ((Duration) -> Int)?
    init(_ screens: [Int]) {
      self.screens = screens
      self.at = start
    }
    init(when: @escaping (Duration) -> Int) {
      self.screens = []
      self.at = start
      self.when = when
    }
    func take() -> Int {
      defer { taken += 1 }
      if let when { return when(at - start) }
      return screens[min(taken, screens.count - 1)]
    }
  }

  private func settle(_ fake: Fake, limit: Duration = .milliseconds(450)) async throws -> Int {
    try await Settle.picture(
      limit: limit, take: { fake.take() }, same: { $0 == $1 }, now: { fake.at },
      pause: { fake.at = fake.at + $0 })
  }

  @Test func aStillScreenIsGivenTheMinimum() async throws {
    let fake = Fake([1, 1])
    #expect(try await settle(fake) == 1)
    // Looks at 0, 50, 100 and 150 ms: the first match past 120 ms.
    #expect(fake.taken == 4)
    #expect(fake.at - fake.start >= Settle.minimum)
  }

  @Test func aScreenThatChangesAfter100msIsWaitedFor() async throws {
    let fake = Fake(when: { $0 < .milliseconds(100) ? 1 : 2 })
    #expect(try await settle(fake) == 2)
  }

  @Test func aChangeSeenEarlyNeedNotWaitOutTheMinimum() async throws {
    let fake = Fake([1, 2, 2])
    #expect(try await settle(fake) == 2)
    #expect(fake.taken == 3)
  }

  @Test func theLimitStillCapsTheWait() async throws {
    let fake = Fake(Array(0..<100))
    _ = try await settle(fake, limit: .milliseconds(1_000))
    #expect(fake.at - fake.start <= .milliseconds(1_000))
  }

  @Test func aMovingScreenIsWaitedForUntilItStops() async throws {
    let fake = Fake([1, 2, 3, 3])
    #expect(try await settle(fake) == 3)
    #expect(fake.taken == 4)
  }

  @Test func aScreenThatNeverStopsIsTakenAtTheLimit() async throws {
    let fake = Fake(Array(0..<100))
    let last = try await settle(fake, limit: .milliseconds(450))
    // A look at the start, then one each beat until the limit: 450 ms is nine beats.
    #expect(fake.taken == 10)
    #expect(last == 9)
  }
}
