import Testing
@testable import DeviceCore

@Suite("Theme")
struct ThemeModeTests {
  /// Every choice here, against every theme the dashboard may have sent (or none) and both macOS appearances.
  @Test(arguments: ThemeChoice.allCases, [nil] + ThemeMode.allCases.map(Optional.some))
  func theChoiceHereThenTheDashboardsThenMacOS(choice: ThemeChoice, sent: ThemeMode?) {
    for systemDark in [false, true] {
      let dark = choice.mode(sent: sent).isDark(systemDark: systemDark)
      let expected: Bool = switch choice {
      case .light: false
      case .dark: true
      case .system: systemDark
      case .dashboard:
        switch sent {
        case .light: false
        case .dark: true
        case .system, nil: systemDark
        }
      }
      #expect(dark == expected, "\(choice) with \(String(describing: sent)) sent, macOS \(systemDark ? "dark" : "light")")
    }
  }

  @Test func followingTheDashboardBeforeItHasSentAThemeIsFollowingMacOS() {
    #expect(ThemeChoice.dashboard.mode(sent: nil) == .system)
    #expect(ThemeChoice.dashboard.mode(sent: .light) == .light)
    #expect(ThemeChoice.light.mode(sent: .dark) == .light)
    #expect(ThemeChoice.system.mode(sent: .dark) == .system)
  }
}
