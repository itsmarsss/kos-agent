import ServiceManagement

/// Opening KOS Device when the owner logs in, through macOS's own login items.
///
/// macOS may want the owner to allow it in System Settings first; then it
/// says so, and the window links there rather than pretending it is on.
enum LaunchAtLogin {
  enum State: Equatable {
    case on, off
    /// Registered, waiting for the owner to allow it under Login Items.
    case needsApproval
  }

  static var state: State {
    switch SMAppService.mainApp.status {
    case .enabled: return .on
    case .requiresApproval: return .needsApproval
    default: return .off
    }
  }

  /// Turns it on or off; the error, in the owner's words, when macOS refused.
  static func set(_ on: Bool) -> String? {
    do {
      if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
      return nil
    } catch {
      return error.localizedDescription
    }
  }

  static func openLoginItems() {
    SMAppService.openSystemSettingsLoginItems()
  }
}
