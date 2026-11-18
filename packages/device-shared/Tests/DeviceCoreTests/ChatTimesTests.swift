import Foundation
import Testing

@testable import DeviceCore

/// The lines between a chat's messages, by the dashboard's rules, on the reader's clock.
@Suite("When messages were said")
struct ChatTimesTests {
  private func calendar(_ zone: String) -> Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: zone)!
    return calendar
  }

  private func at(_ iso: String) -> Date { ISO8601DateFormatter().date(from: iso)! }

  private let newYork = "America/New_York"
  private let us = Locale(identifier: "en_US")

  private func kinds(_ marks: [ChatTimes.Mark?]) -> [String] {
    marks.map { mark in
      switch mark {
      case .day: "day"
      case .gap: "gap"
      case nil: "-"
      }
    }
  }

  @Test func namesTheDayOverTheFirstMessageAndAgainAtMidnight() {
    let marks = ChatTimes.marks([at("2026-11-17T23:58:00-05:00"), at("2026-11-17T23:59:00-05:00"), at("2026-11-18T00:01:00-05:00")], calendar: calendar(newYork))
    #expect(kinds(marks) == ["day", "-", "day"])
  }

  @Test func putsTheTimeOverAMessageAfterAPauseOfFifteenMinutesOrMore() {
    let start = at("2026-11-18T09:00:00-05:00")
    let times = [start, start.addingTimeInterval(ChatTimes.gap - 1), start.addingTimeInterval(2 * ChatTimes.gap - 2), start.addingTimeInterval(3 * ChatTimes.gap + 60)]
    let marks = ChatTimes.marks(times, calendar: calendar(newYork))
    #expect(kinds(marks) == ["day", "-", "-", "gap"])
    #expect(marks[3] == .gap(times[3]))
  }

  @Test func countsAPauseAcrossAChangeOfTheClocksInRealTime() {
    // New York falls back at 02:00 on Nov 1 2026: 01:50 EDT to 01:10 EST is twenty minutes, one day.
    let fall = ChatTimes.marks([at("2026-11-01T01:50:00-04:00"), at("2026-11-01T01:10:00-05:00"), at("2026-11-01T01:20:00-05:00")], calendar: calendar(newYork))
    #expect(kinds(fall) == ["day", "gap", "-"])
    // And springs forward on Mar 8: 01:55 EST to 03:05 EDT is ten minutes.
    let spring = ChatTimes.marks([at("2026-03-08T01:55:00-05:00"), at("2026-03-08T03:05:00-04:00")], calendar: calendar(newYork))
    #expect(kinds(spring) == ["day", "-"])
  }

  @Test func marksTheSameMessagesByTheReadersOwnDay() {
    let times = [at("2026-11-18T04:30:00Z"), at("2026-11-18T05:30:00Z")]
    #expect(kinds(ChatTimes.marks(times, calendar: calendar(newYork))) == ["day", "day"])
    #expect(kinds(ChatTimes.marks(times, calendar: calendar("UTC"))) == ["day", "gap"])
  }

  @Test func passesOverMessagesKeptBeforeMessagesKeptTheirTime() {
    let t = at("2026-11-18T09:00:00Z")
    #expect(kinds(ChatTimes.marks([nil, t, nil, t.addingTimeInterval(60)], calendar: calendar("UTC"))) == ["-", "day", "-", "-"])
    #expect(kinds(ChatTimes.marks([nil, nil])) == ["-", "-"])
  }

  @Test func saysTodayYesterdayTheWeekdayAndTheFullDate() {
    let now = at("2026-11-18T15:00:00-05:00")
    let ny = calendar(newYork)
    #expect(ChatTimes.dayWords(at("2026-11-18T00:05:00-05:00"), now: now, calendar: ny, locale: us) == "Today")
    #expect(ChatTimes.dayWords(at("2026-11-17T23:55:00-05:00"), now: now, calendar: ny, locale: us) == "Yesterday")
    #expect(ChatTimes.dayWords(at("2026-11-16T12:00:00-05:00"), now: now, calendar: ny, locale: us) == "Mon, Nov 16")
    #expect(ChatTimes.dayWords(at("2026-11-11T12:00:00-05:00"), now: now, calendar: ny, locale: us) == "Wed, Nov 11, 2026")
    #expect(ChatTimes.dayWords(at("2026-11-18T09:00:00-05:00"), now: now, calendar: ny, locale: Locale(identifier: "de_DE")) == "Heute")
  }

  @Test func readsATimeALittleAheadOfTheClockAsToday() {
    let late = at("2026-11-18T23:59:00-05:00")
    let ny = calendar(newYork)
    #expect(ChatTimes.dayWords(late.addingTimeInterval(5 * 60), now: late, calendar: ny, locale: us) == "Today")
    #expect(ChatTimes.dayWords(late.addingTimeInterval(3 * 3600), now: late, calendar: ny, locale: us) == "Thu, Nov 19, 2026")
  }

  @Test func tellsTheTimeOnTheLocalesOwnClock() {
    let t = at("2026-11-18T21:41:00-05:00")
    let ny = calendar(newYork)
    #expect(ChatTimes.clock(t, calendar: ny, locale: us).replacingOccurrences(of: "\u{202F}", with: " ") == "9:41 PM")
    #expect(ChatTimes.clock(t, calendar: ny, locale: Locale(identifier: "en_GB")) == "21:41")
    #expect(ChatTimes.words(.gap(t), calendar: ny, locale: Locale(identifier: "en_GB")) == "21:41")
  }
}
