import Foundation
import Testing

@testable import DeviceCore

/// The picture after an action is taken once two looks a beat apart agree, and never later than the limit.
@Suite("Settle")
struct SettleTests {
  /// A clock that moves only when the settle pauses, and screens taken in turn.
  final class Fake: @unchecked Sendable {
    var screens: [Int]
    var taken = 0
    var at = ContinuousClock.now
    init(_ screens: [Int]) { self.screens = screens }
    func take() -> Int {
      defer { taken += 1 }
      return screens[min(taken, screens.count - 1)]
    }
  }

  private func settle(_ fake: Fake, limit: Duration = .milliseconds(450)) async throws -> Int {
    try await Settle.picture(
      limit: limit, take: { fake.take() }, same: { $0 == $1 }, now: { fake.at },
      pause: { fake.at = fake.at + $0 })
  }

  @Test func aStillScreenCostsOneBeat() async throws {
    let fake = Fake([1, 1])
    #expect(try await settle(fake) == 1)
    #expect(fake.taken == 2)
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
