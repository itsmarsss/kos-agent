import Foundation
import Testing

@testable import DeviceCore

/// A call that hangs answers its caller at the limit, so what was set up for it is put back.
@Suite("Deadline")
struct DeadlineTests {
  struct Late: Error {}

  @Test func workThatEndsInTimeAnswers() async throws {
    let value = try await Deadline.run(seconds: 1, timedOut: { Late() }) { 7 }
    #expect(value == 7)
  }

  @Test func workThatHangsIsAnsweredAtTheLimit() async {
    let start = ContinuousClock.now
    await #expect(throws: Late.self) {
      try await Deadline.run(seconds: 0.05, timedOut: { Late() }) {
        // Never ends on its own, and ignores being cancelled.
        await withCheckedContinuation { (_: CheckedContinuation<Void, Never>) in }
      }
    }
    #expect(ContinuousClock.now - start < .seconds(2))
  }

  @Test func anErrorInTimeIsTheWorksOwn() async {
    struct Broke: Error {}
    await #expect(throws: Broke.self) {
      try await Deadline.run(seconds: 1, timedOut: { Late() }) { throw Broke() }
    }
  }
}
