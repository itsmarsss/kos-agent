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

    /// The grant's name to tccutil.
    fileprivate var service: String {
      switch self {
      case .screen: return "ScreenCapture"
      case .input: return "Accessibility"
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

  /// Adds this app to the grant's list in System Settings, with macOS's own prompt.
  ///
  /// An ad hoc build is a new identity to macOS each time it is built, and
  /// an older build's row in the list looks like this one but answers for
  /// the old build: switching it on and off does nothing for this one. So
  /// this app's own row is cleared first, and macOS asks for this build.
  static func request(_ kind: Kind) {
    if let bundle = Bundle.main.bundleIdentifier {
      let reset = Process()
      reset.executableURL = URL(fileURLWithPath: "/usr/bin/tccutil")
      reset.arguments = ["reset", kind.service, bundle]
      try? reset.run()
      reset.waitUntilExit()
    }
    switch kind {
    case .screen:
      _ = CGRequestScreenCaptureAccess()
    case .input:
      let prompt = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
      _ = AXIsProcessTrustedWithOptions([prompt: true] as CFDictionary)
    }
  }

  /// Quits and opens again: macOS lets a new grant of Screen Recording apply only to a fresh start.
  static func relaunch() {
    let reopen = Process()
    reopen.executableURL = URL(fileURLWithPath: "/bin/sh")
    reopen.arguments = ["-c", "sleep 0.8; /usr/bin/open \"$0\"", Bundle.main.bundlePath]
    try? reopen.run()
    NSApp.terminate(nil)
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
