import DeviceCore
import DeviceKit
import Foundation

/// The glance: what KOS has on the go, what waits on the owner, what is
/// failing and what runs next, as KOS last answered it (docs/computer.md,
/// Glance). Asked for when the app comes to the front, when the glance is
/// opened, and when a turn ends. Each ask it carries is decided here, in any
/// chat, as the dashboard decides it.
@MainActor
public final class GlanceModel: ObservableObject {
  /// An approval waiting on the owner, and the chat it is for by its title.
  public struct Waiting: Equatable, Identifiable, Sendable {
    public let ask: ChatModel.Ask
    public let chat: String?
    public var id: String { ask.id }
  }

  @Published public private(set) var report: Glance?
  /// The asks KOS sent, less those decided since.
  @Published public private(set) var asks: [Waiting] = []
  /// When KOS last answered.
  @Published public private(set) var at: Date?
  /// Asked and not yet answered.
  @Published public private(set) var asking = false

  /// Asks KOS; the app sends the event.
  public var askKOS: () -> Void = {}
  /// An ask decided here; the app sends the decision.
  public var decide: (_ id: String, _ approved: Bool, _ remember: Bool) -> Void = { _, _, _ in }

  /// Decided since KOS last said, so the count goes down with the rows.
  private var gone: Set<String> = []

  public init() {}

  /// Every approval waiting on the owner, as KOS counted them, less those decided here since.
  public var waiting: Int { max(0, (report?.waiting ?? 0) - gone.count) }

  public func ask() {
    asking = true
    askKOS()
  }

  public func received(_ glance: Glance, at now: Date = Date()) {
    report = glance
    gone = []
    asks = glance.asks.map { Waiting(ask: ChatCalls.ask($0.approval, chat: $0.chat?.id), chat: $0.chat?.title) }
    at = now
    asking = false
  }

  /// The owner's decision: the row goes at once, and KOS is told.
  public func answer(_ id: String, approved: Bool, remember: Bool = false) {
    guard asks.contains(where: { $0.id == id }) else { return }
    settled(id)
    decide(id, approved, remember)
  }

  /// Decided, here or elsewhere: no longer waiting.
  public func settled(_ id: String) {
    guard asks.contains(where: { $0.id == id }) else { return }
    asks.removeAll { $0.id == id }
    gone.insert(id)
  }

  /// Another KOS, or none: nothing of the last one's stays.
  public func reset() {
    report = nil
    asks = []
    gone = []
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
    if waiting > 0 { parts.append("\(waiting) waiting on you") }
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

  /// How long an ask has before it answers itself, to the minute as a glance needs it: "lapses in 4m".
  public static func lapses(_ at: Date, now: Date = Date()) -> String {
    let seconds = Int(at.timeIntervalSince(now).rounded(.up))
    if seconds <= 0 { return "lapses now" }
    if seconds < 60 { return "lapses in \(seconds)s" }
    let minutes = Int((Double(seconds) / 60).rounded(.up))
    return minutes < 60 ? "lapses in \(minutes)m" : "lapses in \(Int((Double(minutes) / 60).rounded()))h"
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
