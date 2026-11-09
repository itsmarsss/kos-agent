import Testing
@testable import DeviceCore

@Suite("Theme")
struct ThemeModeTests {
  /// What the dashboard may have sent (or nothing), and what Same as dashboard draws for it, written out.
  static let dashboard: [(DashboardTheme?, ThemeMode)] = [
    (nil, .system),
    (DashboardTheme(mode: .light), .light),
    (DashboardTheme(mode: .light, drawn: .light), .light),
    (DashboardTheme(mode: .light, drawn: .dark), .dark),
    (DashboardTheme(mode: .dark), .dark),
    (DashboardTheme(mode: .dark, drawn: .light), .light),
    (DashboardTheme(mode: .dark, drawn: .dark), .dark),
    (DashboardTheme(mode: .system), .system),
    (DashboardTheme(mode: .system, drawn: .light), .light),
    (DashboardTheme(mode: .system, drawn: .dark), .dark),
  ]

  /// Same as dashboard draws as the dashboard looks: its palette, else its mode, else macOS's.
  @Test(arguments: dashboard)
  func sameAsDashboardDrawsWhatItWasSent(sent: DashboardTheme?, expected: ThemeMode) {
    #expect(ThemeChoice.dashboard.mode(sent: sent) == expected, "\(String(describing: sent)) sent")
  }

  /// Light, Dark and System here ignore whatever the dashboard sent.
  @Test(arguments: [(ThemeChoice.light, ThemeMode.light), (.dark, .dark), (.system, .system)])
  func theChoiceHereWinsOverTheDashboard(choice: ThemeChoice, expected: ThemeMode) {
    for (sent, _) in Self.dashboard {
      #expect(choice.mode(sent: sent) == expected, "\(choice) with \(String(describing: sent)) sent")
    }
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
