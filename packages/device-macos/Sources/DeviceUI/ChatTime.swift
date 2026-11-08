import Foundation

/// A time KOS wrote once, read on this Mac's clock, as the dashboard reads it
/// (`packages/shared/src/time.ts`): `<t:1760845320:R>` or the time as written,
/// `<t:2026-10-19T07:30:R>`, in this Mac's zone unless an offset says
/// otherwise. The style letters are Discord's; R is "in 3 hours".
public enum ChatTime {
  /// One token: unix seconds or an ISO date or date-time, then a style letter.
  static let token = #"<t:(\d{9,11}|\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?(?:Z|[+-]\d{2}:?\d{2})?)(?::([tTdDfFR]))?>"#

  /// The moment a token's value names, or nothing when it does not parse.
  public static func instant(_ value: String, zone: TimeZone = .current) -> Date? {
    if value.allSatisfy(\.isNumber), let seconds = TimeInterval(value) { return Date(timeIntervalSince1970: seconds) }
    let iso = #"^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?(Z|[+-]\d{2}:?\d{2})?$"#
    guard let m = groups(iso, value) else { return nil }
    let (year, month, day) = (Int(m[1]) ?? 0, Int(m[2]) ?? 0, Int(m[3]) ?? 0)
    let (hour, minute, second) = (Int(m[4]) ?? 0, Int(m[5]) ?? 0, Int(m[6]) ?? 0)
    guard (1...12).contains(month), (1...31).contains(day), hour <= 23, minute <= 59, second <= 59 else { return nil }
    let parts = DateComponents(year: year, month: month, day: day, hour: hour, minute: minute, second: second)
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = offsetZone(m[7]) ?? zone
    return calendar.date(from: parts)
  }

  /// The zone an offset in a token names: Z, +02:00, -0400.
  private static func offsetZone(_ offset: String) -> TimeZone? {
    if offset.isEmpty { return nil }
    if offset == "Z" { return TimeZone(secondsFromGMT: 0) }
    let digits = offset.dropFirst().replacingOccurrences(of: ":", with: "")
    guard let hours = Int(digits.prefix(2)), let minutes = Int(digits.dropFirst(2)) else { return nil }
    let seconds = (hours * 60 + minutes) * 60
    return TimeZone(secondsFromGMT: offset.hasPrefix("-") ? -seconds : seconds)
  }

  /// How far off a moment is, in words: "in 3 hours", "2 days ago", "in a moment".
  public static func relative(_ date: Date, now: Date = Date()) -> String {
    let diff = Int(date.timeIntervalSince1970) - Int(now.timeIntervalSince1970.rounded(.down))
    let gap = abs(diff)
    if gap < 45 { return diff < 0 ? "just now" : "in a moment" }
    let units: [(String, Int)] = [("year", 31_536_000), ("month", 2_592_000), ("day", 86_400), ("hour", 3_600), ("minute", 60)]
    var words = "a minute"
    for (unit, size) in units {
      let n = Int((Double(gap) / Double(size)).rounded())
      if n >= 1, Double(gap) >= Double(size) * 0.9 {
        words = n == 1 ? "\(unit == "hour" ? "an" : "a") \(unit)" : "\(n) \(unit)s"
        break
      }
    }
    return diff < 0 ? "\(words) ago" : "in \(words)"
  }

  /// A moment in one of Discord's styles, on this Mac's clock, as the dashboard writes each.
  public static func words(_ date: Date, style: Character = "f", now: Date = Date(), zone: TimeZone = .current) -> String {
    if style == "R" { return relative(date, now: now) }
    let format: String
    switch style {
    case "t": format = "HH:mm"
    case "T": format = "HH:mm:ss"
    case "d": format = "dd/MM/yyyy"
    case "D": format = "d MMMM yyyy"
    case "F": format = "EEEE d MMMM yyyy HH:mm"
    default: format = "d MMMM yyyy HH:mm"
    }
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = zone
    formatter.dateFormat = format
    return formatter.string(from: date)
  }

  /// The hover card's two lines, in the reader's locale and on its own 12- or 24-hour clock:
  /// "Friday, November 20, 2026" over "at 11:59 PM".
  public static func card(_ date: Date, locale: Locale = .current, zone: TimeZone = .current) -> (date: String, time: String) {
    let day = DateFormatter()
    day.locale = locale
    day.timeZone = zone
    day.setLocalizedDateFormatFromTemplate("EEEEMMMMdy")
    let clock = DateFormatter()
    clock.locale = locale
    clock.timeZone = zone
    clock.dateStyle = .none
    clock.timeStyle = .short
    return (day.string(from: date), "at \(clock.string(from: date))")
  }

  /// Every token in a line, in order, with what it reads as; one that does not parse is left out.
  static func tokens(in text: String) -> [(range: Range<String.Index>, date: Date, style: Character)] {
    guard let re = try? NSRegularExpression(pattern: token) else { return [] }
    return re.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { m in
      guard let whole = Range(m.range, in: text), let value = Range(m.range(at: 1), in: text),
            let date = instant(String(text[value])) else { return nil }
      let style = Range(m.range(at: 2), in: text).flatMap { text[$0].first } ?? "f"
      return (whole, date, style)
    }
  }

  /// A line with each time as its words, for where a chip cannot go.
  static func inWords(_ text: String, now: Date = Date()) -> String {
    var out = text
    for found in tokens(in: text).reversed() {
      out.replaceSubrange(found.range, with: words(found.date, style: found.style, now: now))
    }
    return out
  }

    /// The hover text for a line's times, a card each, or nothing when it has none.
  public static func help(for text: String) -> String? {
    let cards = tokens(in: text).map { card($0.date) }.map { "\($0.date)\n\($0.time)" }
    return cards.isEmpty ? nil : cards.joined(separator: "\n\n")
  }

  private static func groups(_ pattern: String, _ text: String) -> [String]? {
    guard let re = try? NSRegularExpression(pattern: pattern),
          let m = re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) else { return nil }
    return (0..<m.numberOfRanges).map { i in Range(m.range(at: i), in: text).map { String(text[$0]) } ?? "" }
  }
}
