import Testing
@testable import DeviceCore

@Suite("Theme")
struct ThemeModeTests {
  /// Every choice here, against every theme the dashboard may have sent (or none).
  @Test(arguments: ThemeChoice.allCases, [nil] + ThemeMode.allCases.map(Optional.some))
  func theChoiceHereThenTheDashboardsThenMacOS(choice: ThemeChoice, sent: ThemeMode?) {
    let expected: ThemeMode = switch choice {
    case .light: .light
    case .dark: .dark
    case .system: .system
    case .dashboard: sent ?? .system
    }
    #expect(choice.mode(sent: sent) == expected, "\(choice) with \(String(describing: sent)) sent")
  }

  @Test func followingTheDashboardBeforeItHasSentAThemeIsFollowingMacOS() {
    #expect(ThemeChoice.dashboard.mode(sent: nil) == .system)
    #expect(ThemeChoice.dashboard.mode(sent: .light) == .light)
    #expect(ThemeChoice.light.mode(sent: .dark) == .light)
    #expect(ThemeChoice.system.mode(sent: .dark) == .system)
  }
}
