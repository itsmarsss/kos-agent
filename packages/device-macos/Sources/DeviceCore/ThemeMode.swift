/// How a KOS's dashboard is set to look, as it sends it in a theme frame (docs/computer.md).
public enum ThemeMode: String, Codable, CaseIterable, Sendable {
  case light, dark, system

  /// Dark or not, where `system` is what macOS is set to now.
  public func isDark(systemDark: Bool) -> Bool {
    switch self {
    case .light: return false
    case .dark: return true
    case .system: return systemDark
    }
  }
}

/// How the owner set KOS for Mac to look: as the dashboard is, or one of its three themes regardless.
public enum ThemeChoice: String, CaseIterable, Sendable {
  case dashboard, light, dark, system

  /// The theme to draw in, given what the dashboard last sent: macOS's own until it has sent one.
  public func mode(sent: ThemeMode?) -> ThemeMode {
    switch self {
    case .dashboard: return sent ?? .system
    case .light: return .light
    case .dark: return .dark
    case .system: return .system
    }
  }
}
