import Foundation
import OSLog

/// What KOS Device writes to the system log, by part, so a line that dropped
/// or a pairing that would not read can be found afterwards:
///
///     /usr/bin/log show --predicate 'subsystem == "com.itsmarsss.kos-device"' --last 1h
///
/// (In zsh a bare `log` is the shell's own builtin.)
///
/// Written at notice level, which macOS keeps, rather than info, which it
/// drops. A task's words are private; addresses, states and reasons are not.
enum Log {
  static let subsystem = "com.itsmarsss.kos-device"
  static let app = Logger(subsystem: subsystem, category: "app")
  static let line = Logger(subsystem: subsystem, category: "line")
  static let pairing = Logger(subsystem: subsystem, category: "pairing")
  static let session = Logger(subsystem: subsystem, category: "session")

  /// This run's entries, oldest first, for the owner to copy and send.
  static func recent(limit: Int = 500) -> String {
    do {
      let store = try OSLogStore(scope: .currentProcessIdentifier)
      let entries = try store.getEntries(
        at: store.position(timeIntervalSinceLatestBoot: 0),
        matching: NSPredicate(format: "subsystem == %@", subsystem))
      let stamp = Date.ISO8601FormatStyle(includingFractionalSeconds: false).time(includingFractionalSeconds: false)
      let lines = entries.compactMap { $0 as? OSLogEntryLog }.suffix(limit).map { entry in
        "\(entry.date.formatted(stamp)) [\(entry.category)] \(entry.composedMessage)"
      }
      return lines.isEmpty ? "Nothing logged yet." : lines.joined(separator: "\n")
    } catch {
      return "The log could not be read: \(error.localizedDescription)"
    }
  }
}
