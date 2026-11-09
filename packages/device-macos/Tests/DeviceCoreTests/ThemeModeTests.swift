import Testing
@testable import DeviceCore

@Suite("Theme")
struct ThemeModeTests {
  static let sent: [DashboardTheme?] = [nil] + ThemeMode.allCases.flatMap { mode in
    ([nil] + DrawnTheme.allCases.map(Optional.some)).map { DashboardTheme(mode: mode, drawn: $0) }
  }

  /// Every choice here, against every theme and palette the dashboard may have sent (or none).
  @Test(arguments: ThemeChoice.allCases, sent)
  func theChoiceHereThenTheDashboardsThenMacOS(choice: ThemeChoice, sent: DashboardTheme?) {
    let expected: ThemeMode = switch choice {
    case .light: .light
    case .dark: .dark
    case .system: .system
    case .dashboard: sent?.drawn?.mode ?? sent?.mode ?? .system
    }
    #expect(choice.mode(sent: sent) == expected, "\(choice) with \(String(describing: sent)) sent")
  }

  @Test func followingTheDashboardBeforeItHasSentAThemeIsFollowingMacOS() {
    #expect(ThemeChoice.dashboard.mode(sent: nil) == .system)
    #expect(ThemeChoice.dashboard.mode(sent: DashboardTheme(mode: .light)) == .light)
    #expect(ThemeChoice.light.mode(sent: DashboardTheme(mode: .dark)) == .light)
    #expect(ThemeChoice.system.mode(sent: DashboardTheme(mode: .dark)) == .system)
  }

  /// The owner's case: the dashboard set to System in a Chrome forced dark, on a Mac in light. Same as dashboard is dark.
  @Test func sameAsDashboardIsHowTheDashboardLooks() {
    let forcedDark = DashboardTheme(mode: .system, drawn: .dark)
    #expect(ThemeChoice.dashboard.mode(sent: forcedDark) == .dark)
    #expect(ThemeChoice.system.mode(sent: forcedDark) == .system)
    // From a KOS that has heard no dashboard say, System is still this Mac's.
    #expect(ThemeChoice.dashboard.mode(sent: DashboardTheme(mode: .system)) == .system)
  }
}
