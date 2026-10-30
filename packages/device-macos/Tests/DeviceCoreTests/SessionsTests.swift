import Foundation
import Testing
@testable import DeviceCore

private let space = Space(display: Rect(x: 0, y: 0, width: 1512, height: 982))
private let start = Date(timeIntervalSince1970: 1_000_000)

private func liveSessions(minutes: Int = 15) throws -> Sessions {
  var sessions = Sessions()
  try sessions.ask("s1")
  _ = try sessions.grant("s1", task: "Open the file", requester: "School", minutes: minutes, space: space, now: start)
  return sessions
}

private func code(_ body: () throws -> Void) -> ErrorCode? {
  do {
    try body()
    return nil
  } catch let error as DeviceError {
    return error.code
  } catch {
    return nil
  }
}

@Suite("Sessions")
struct SessionsTests {
  @Test func nothingActsWithoutALiveSession() {
    var sessions = Sessions()
    #expect(code { _ = try sessions.authorize("s1", now: start) } == .noSession)
  }

  @Test func aGrantedSessionAuthorizesItsOwnCalls() throws {
    var sessions = try liveSessions()
    let live = try sessions.authorize("s1", now: start.addingTimeInterval(5))
    #expect(live.task == "Open the file")
    #expect(live.until == start.addingTimeInterval(15 * 60))
    #expect(code { _ = try sessions.authorize("other", now: start) } == .noSession)
  }

  @Test func oneAtATime() throws {
    var sessions = try liveSessions()
    #expect(code { try sessions.ask("s2") } == .busy)
    var asking = Sessions()
    try asking.ask("s1")
    #expect(code { try asking.ask("s2") } == .busy)
  }

  @Test func aGrantMustAnswerWhatWasAsked() throws {
    var sessions = Sessions()
    #expect(code { _ = try sessions.grant("s1", task: "", requester: "", minutes: 5, space: space, now: start) } == .noSession)
    try sessions.ask("s1")
    #expect(code { _ = try sessions.grant("s2", task: "", requester: "", minutes: 5, space: space, now: start) } == .noSession)
  }

  @Test func aDenialFreesTheDevice() throws {
    var sessions = Sessions()
    try sessions.ask("s1")
    sessions.deny("s1")
    #expect(sessions.phase == .idle)
    try sessions.ask("s2")
  }

  @Test func theOwnerPausesAndOnlyTheOwnerResumes() throws {
    var sessions = try liveSessions()
    #expect(sessions.pause() == "s1")
    #expect(sessions.pause() == nil)
    #expect(code { _ = try sessions.authorize("s1", now: start) } == .paused)
    #expect(sessions.resume(now: start) == "s1")
    #expect(sessions.resume(now: start) == nil)
    _ = try sessions.authorize("s1", now: start)
  }

  @Test func endsAtItsTimeLimit() throws {
    var sessions = try liveSessions(minutes: 5)
    _ = try sessions.authorize("s1", now: start.addingTimeInterval(170))
    #expect(sessions.due(start.addingTimeInterval(4 * 60)) == nil)
    #expect(sessions.due(start.addingTimeInterval(5 * 60)) == .expired)
  }

  @Test func endsAfterThreeIdleMinutes() throws {
    var sessions = try liveSessions(minutes: 30)
    #expect(sessions.due(start.addingTimeInterval(179)) == nil)
    _ = try sessions.authorize("s1", now: start.addingTimeInterval(120))
    #expect(sessions.due(start.addingTimeInterval(299)) == nil)
    #expect(sessions.due(start.addingTimeInterval(300)) == .idle)
  }

  @Test func aCallAfterItIsDueIsRefused() throws {
    var sessions = try liveSessions(minutes: 5)
    #expect(code { _ = try sessions.authorize("s1", now: start.addingTimeInterval(301)) } == .noSession)
  }

  @Test func resumingRestartsTheIdleClock() throws {
    var sessions = try liveSessions(minutes: 30)
    _ = sessions.pause()
    _ = sessions.resume(now: start.addingTimeInterval(170))
    #expect(sessions.due(start.addingTimeInterval(200)) == nil)
  }

  @Test func endingSaysWhatEnded() throws {
    var sessions = try liveSessions()
    #expect(sessions.end() == "s1")
    #expect(sessions.end() == nil)
    #expect(sessions.live == nil)
    var asking = Sessions()
    try asking.ask("s9")
    #expect(asking.end() == "s9")
  }
}

@Suite("Session time")
struct SessionTimeTests {
  private func live(_ sessions: inout Sessions, at start: Date, minutes: Int) throws {
    try sessions.ask("s1")
    _ = try sessions.grant("s1", task: "t", requester: "r", minutes: minutes, space: Space(display: Rect(x: 0, y: 0, width: 100, height: 100)), now: start)
  }

  @Test func endsWhenIdleForAsLongAsTheOwnerSet() throws {
    var sessions = Sessions()
    sessions.idleLimit = 60
    let start = Date(timeIntervalSince1970: 1_000)
    try live(&sessions, at: start, minutes: 30)
    #expect(sessions.due(start.addingTimeInterval(59)) == nil)
    #expect(sessions.due(start.addingTimeInterval(60)) == .idle)
  }

  @Test func plusFifteenAddsAQuarterHourAndNoMoreThanEight() throws {
    var sessions = Sessions()
    let start = Date(timeIntervalSince1970: 1_000)
    try live(&sessions, at: start, minutes: 10)
    let first = sessions.extend(now: start)
    #expect(first == start.addingTimeInterval(25 * 60))
    for _ in 0..<40 { _ = sessions.extend(now: start) }
    #expect(sessions.live?.until == start.addingTimeInterval(8 * 60 * 60))
    _ = sessions.end()
    let none = sessions.extend(now: start)
    #expect(none == nil)
  }
}

@Suite("Session lengths")
struct DurationsTests {
  @Test func offersUpToWhatKOSAskedFor() {
    #expect(Durations.offered(requested: 15) == [5, 15])
    #expect(Durations.offered(requested: 20) == [5, 15, 20])
    #expect(Durations.offered(requested: 2) == [2])
    #expect(Durations.offered(requested: 0.5) == [1])
  }

  @Test func neverPastTheLongestTheOwnerSet() {
    #expect(Durations.offered(requested: 240) == [5, 15, 30, 60])
    #expect(Durations.unattended(requested: 240) == 60)
    #expect(Durations.unattended(requested: 10) == 10)
    #expect(Durations.offered(requested: 240, longest: 480) == [5, 15, 30, 60, 120, 240])
    #expect(Durations.offered(requested: 90, longest: 120) == [5, 15, 30, 60, 90])
    #expect(Durations.unattended(requested: 600, longest: 240) == 240)
  }

  @Test func minutesMustBePositive() {
    #expect(throws: DeviceError.self) { try Durations.validate(0) }
    #expect(throws: DeviceError.self) { try Durations.validate(-3) }
    #expect(throws: DeviceError.self) { try Durations.validate(.nan) }
  }
}
