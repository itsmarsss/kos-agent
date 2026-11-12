import DeviceCore
import Foundation

/// The glance: what KOS has on the go, what is failing and what runs next,
/// as KOS last answered it (docs/computer.md, Glance). Asked for when the
/// app comes to the front, when the glance is opened, and when a turn ends.
@MainActor
public final class GlanceModel: ObservableObject {
  @Published public private(set) var report: Glance?
  /// When KOS last answered.
  @Published public private(set) var at: Date?
  /// Asked and not yet answered.
  @Published public private(set) var asking = false

  /// Asks KOS; the app sends the event.
  public var askKOS: () -> Void = {}

  public init() {}

  public func ask() {
    asking = true
    askKOS()
  }

  public func received(_ glance: Glance, at now: Date = Date()) {
    report = glance
    at = now
    asking = false
  }

  /// Another KOS, or none: nothing of the last one's stays.
  public func reset() {
    report = nil
    at = nil
    asking = false
  }

  /// What wants the owner's eye, for the button's mark: something failing, or KOS halted.
  public var alarming: Bool {
    guard let report else { return false }
    return report.halted || !report.failing.isEmpty
  }

  /// The glance in one line, for the button's label and VoiceOver.
  public var summary: String {
    guard let report else { return "What KOS is doing" }
    var parts: [String] = []
    if report.halted { parts.append("KOS is halted") }
    parts.append(report.running.isEmpty ? "Nothing running" : "\(report.running.count) running")
    if !report.failing.isEmpty { parts.append("\(report.failing.count) failing") }
    if report.waiting > 0 { parts.append("\(report.waiting) waiting on you") }
    return parts.joined(separator: ", ")
  }
}

/// Times as the glance says them, short.
public enum GlanceWords {
  /// When a schedule runs next: "in 4m", "in 3h", "tomorrow 09:00", "Fri 09:00", "now".
  public static func next(_ at: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
    let seconds = at.timeIntervalSince(now)
    if seconds < 60 { return "now" }
    let minutes = Int((seconds / 60).rounded())
    if minutes < 60 { return "in \(minutes)m" }
    let time = clock(at, calendar: calendar)
    if calendar.isDate(at, inSameDayAs: now) { return minutes < 6 * 60 ? "in \(Int((Double(minutes) / 60).rounded()))h" : "at \(time)" }
    if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now), calendar.isDate(at, inSameDayAs: tomorrow) { return "tomorrow \(time)" }
    let day = DateFormatter()
    day.calendar = calendar
    day.timeZone = calendar.timeZone
    day.locale = calendar.locale ?? .current
    day.setLocalizedDateFormatFromTemplate(seconds < 6 * 86_400 ? "EEE" : "MMM d")
    return "\(day.string(from: at)) \(time)"
  }

  /// When KOS last answered: "Updated just now", "Updated 3m ago".
  public static func updated(_ at: Date, now: Date = Date()) -> String {
    let minutes = Int((now.timeIntervalSince(at) / 60).rounded(.down))
    if minutes < 1 { return "Updated just now" }
    return minutes < 60 ? "Updated \(minutes)m ago" : "Updated \(minutes / 60)h ago"
  }

  /// How long a job has been failing: "for 12m", "for 3h", "for 2d".
  public static func failingFor(since: Date, now: Date = Date()) -> String {
    let minutes = max(0, Int((now.timeIntervalSince(since) / 60).rounded()))
    if minutes < 1 { return "just now" }
    if minutes < 60 { return "for \(minutes)m" }
    let hours = Int((Double(minutes) / 60).rounded())
    return hours < 48 ? "for \(hours)h" : "for \(Int((Double(hours) / 24).rounded()))d"
  }

  /// How many runs failed in a row, said plainly.
  public static func streak(_ count: Int) -> String {
    count <= 1 ? "Failed its last run" : "Failed \(count) runs in a row"
  }

  private static func clock(_ at: Date, calendar: Calendar) -> String {
    let parts = calendar.dateComponents([.hour, .minute], from: at)
    return String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
  }
}
