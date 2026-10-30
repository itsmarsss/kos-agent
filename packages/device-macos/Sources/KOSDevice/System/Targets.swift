import AppKit
import Carbon
import DeviceCore

/// What an action would land on: the app under a point, the app in front, and whether a password field has focus.
@MainActor
enum Targets {
  static func frontmost() -> NSRunningApplication? {
    NSWorkspace.shared.frontmostApplication
  }

  static func describe(_ app: NSRunningApplication?) -> FrontApp? {
    guard let app else { return nil }
    return FrontApp(name: app.localizedName ?? app.bundleIdentifier ?? "Unknown", bundle: app.bundleIdentifier ?? "")
  }

  /// The app owning the topmost window under `point` (global, top-left), not counting this one.
  static func app(at point: CGPoint) -> NSRunningApplication? {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else { return nil }
    let me = getpid()
    for window in windows {
      guard let pid = window[kCGWindowOwnerPID as String] as? pid_t, pid != me,
            (window[kCGWindowAlpha as String] as? Double ?? 1) > 0,
            let bounds = window[kCGWindowBounds as String] as? NSDictionary,
            let frame = CGRect(dictionaryRepresentation: bounds), frame.contains(point) else { continue }
      return NSRunningApplication(processIdentifier: pid)
    }
    return nil
  }

  /// macOS turns secure input on while a password field has focus, and keeps keystrokes from other apps' eyes.
  static var passwordFieldHasFocus: Bool {
    IsSecureEventInputEnabled()
  }
}
