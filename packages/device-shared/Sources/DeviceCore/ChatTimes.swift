import Foundation

/// When a chat's messages were said, as every surface marks it: the rules of
/// the dashboard's `packages/shared/src/chattime.ts`, so KOS for Mac and KOS
/// for iPhone mark the same places. A line naming the day where the day
/// changes, the time over a message said after a long pause, and each
/// message's own time when the owner asks for it; on the device's own clock,
/// in the owner's locale and 12- or 24-hour preference.
public enum ChatTimes {
  /// A pause this long or longer between two messages puts the time over the second.
  public static let gap: TimeInterval = 15 * 60

  /// A quiet line between messages: the day where it changes, the time after a pause.
  public enum Mark: Equatable, Sendable {
    case day(Date)
    case gap(Date)
  }

  /// The line over each message, given when each was said, in order: the day over the first message of each day (the
  /// first one with a time too), the time over one said `gap` or more after the one before it, and none otherwise. A
  /// message with no time, kept before messages kept theirs, has no line and is passed over.
  public static func marks(_ times: [Date?], calendar: Calendar = .autoupdatingCurrent) -> [Mark?] {
    var last: Date?
    return times.map { at in
      guard let at else { return nil }
      defer { last = at }
      guard let before = last, calendar.isDate(at, inSameDayAs: before) else { return .day(at) }
      return at.timeIntervalSince(before) >= gap ? .gap(at) : nil
    }
  }

  /// What the line over a new day says: "Today", "Yesterday", the weekday and date for the rest of the week ("Mon, Nov
  /// 16"), and the full date with its year before that, each in the owner's locale.
  public static func dayWords(_ date: Date, now: Date = Date(), calendar: Calendar = .autoupdatingCurrent, locale: Locale = .autoupdatingCurrent) -> String {
    let ago = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day ?? 0
    let formatter = DateFormatter()
    formatter.locale = locale
    formatter.calendar = calendar
    formatter.timeZone = calendar.timeZone
    if ago == 0 || ago == 1 {
      formatter.dateStyle = .medium
      formatter.timeStyle = .none
      formatter.doesRelativeDateFormatting = true
    } else {
      formatter.setLocalizedDateFormatFromTemplate(ago > 1 && ago < 7 ? "EEEMMMd" : "EEEMMMdy")
    }
    return formatter.string(from: date)
  }

  /// A message's time on the owner's clock, hours and minutes: "9:41 AM", "21:41".
  public static func clock(_ date: Date, calendar: Calendar = .autoupdatingCurrent, locale: Locale = .autoupdatingCurrent) -> String {
    let formatter = DateFormatter()
    formatter.locale = locale
    formatter.calendar = calendar
    formatter.timeZone = calendar.timeZone
    formatter.dateStyle = .none
    formatter.timeStyle = .short
    return formatter.string(from: date)
  }

  /// What a mark says: the day's words, or the time after a pause.
  public static func words(_ mark: Mark, now: Date = Date(), calendar: Calendar = .autoupdatingCurrent, locale: Locale = .autoupdatingCurrent) -> String {
    switch mark {
    case .day(let date): return dayWords(date, now: now, calendar: calendar, locale: locale)
    case .gap(let date): return clock(date, calendar: calendar, locale: locale)
    }
  }
}
