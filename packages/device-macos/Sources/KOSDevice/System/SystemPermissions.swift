import AppKit
import ApplicationServices
import DeviceCore

/// The two grants macOS asks the owner for: seeing the screen, and using the mouse and keyboard.
enum SystemPermissions {
  enum Kind {
    case screen, input

    var title: String {
      switch self {
      case .screen: return "Screen Recording"
      case .input: return "Accessibility"
      }
    }

    fileprivate var pane: String {
      switch self {
      case .screen: return "Privacy_ScreenCapture"
      case .input: return "Privacy_Accessibility"
      }
    }
  }

  static func current() -> Permissions {
    Permissions(screen: CGPreflightScreenCaptureAccess(), input: AXIsProcessTrusted())
  }

  static func isGranted(_ kind: Kind) -> Bool {
    switch kind {
    case .screen: return CGPreflightScreenCaptureAccess()
    case .input: return AXIsProcessTrusted()
    }
  }

  /// Adds this app to the grant's list in System Settings, with macOS's own prompt the first time.
  static func request(_ kind: Kind) {
    switch kind {
    case .screen:
      _ = CGRequestScreenCaptureAccess()
    case .input:
      let prompt = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
      _ = AXIsProcessTrustedWithOptions([prompt: true] as CFDictionary)
    }
  }

  static func openSettings(_ kind: Kind) {
    guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(kind.pane)") else { return }
    NSWorkspace.shared.open(url)
  }

  /// What is missing, as the owner reads it; nothing when both are granted.
  static func missing(_ permissions: Permissions) -> String? {
    switch (permissions.screen, permissions.input) {
    case (true, true): return nil
    case (false, true): return "Screen Recording is not granted on this Mac."
    case (true, false): return "Accessibility is not granted on this Mac."
    case (false, false): return "Screen Recording and Accessibility are not granted on this Mac."
    }
  }
}
