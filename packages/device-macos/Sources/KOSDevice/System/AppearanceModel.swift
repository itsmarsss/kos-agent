import AppKit
import DeviceCore

/// The one place the app's look is set: the owner's choice here, over the
/// theme the dashboard of the KOS the app speaks of last sent.
///
/// It sets the application's appearance and nothing else. Every window takes
/// it from there, every token (Theme) is drawn in it, and SwiftUI's
/// colorScheme follows it. Following macOS, the appearance is left unset, so
/// AppKit itself follows a change of macOS's own while the app runs.
@MainActor
final class AppearanceModel {
  var choice: ThemeChoice { didSet { apply() } }
  /// The dashboard's theme, as the KOS the app speaks of last sent it; nil before any has.
  var sent: ThemeMode? { didSet { apply() } }

  init(choice: ThemeChoice, sent: ThemeMode? = nil) {
    self.choice = choice
    self.sent = sent
    apply()
  }

  var mode: ThemeMode { choice.mode(sent: sent) }

  private func apply() {
    let name: NSAppearance.Name? = switch mode {
    case .light: .aqua
    case .dark: .darkAqua
    case .system: nil
    }
    guard NSApp.appearance?.name != name else { return }
    NSApp.appearance = name.flatMap(NSAppearance.init(named:))
  }
}
