/// How a KOS's dashboard is set to look, as it sends it in a theme frame (docs/computer.md).
public enum ThemeMode: String, Codable, CaseIterable, Sendable {
  case light, dark, system
}

/// A palette as a dashboard draws it: what its mode lands on, System read in the dashboard's own browser.
public enum DrawnTheme: String, Codable, CaseIterable, Sendable {
  case light, dark

  public var mode: ThemeMode { self == .light ? .light : .dark }
}

/// The dashboard's theme as KOS sends it: the owner's setting, and the palette a dashboard last reported drawing it in.
public struct DashboardTheme: Equatable, Sendable {
  public let mode: ThemeMode
  /// Nil from a KOS that has heard no dashboard report one, or that predates the report.
  public let drawn: DrawnTheme?

  public init(mode: ThemeMode, drawn: DrawnTheme? = nil) {
    self.mode = mode
    self.drawn = drawn
  }

  /// How the dashboard looks: the palette it is drawn in, else its mode, System then being this Mac's.
  public var look: ThemeMode { drawn?.mode ?? mode }
}

/// How the owner set KOS for Mac to look: as the dashboard is, or one of its three themes regardless.
public enum ThemeChoice: String, CaseIterable, Sendable {
  case dashboard, light, dark, system

  /// The theme to draw in, given what the dashboard last sent: how it looks, and macOS's own until it has sent one.
  public func mode(sent: DashboardTheme?) -> ThemeMode {
    switch self {
    case .dashboard: return sent?.look ?? .system
    case .light: return .light
    case .dark: return .dark
    case .system: return .system
    }
  }
}
