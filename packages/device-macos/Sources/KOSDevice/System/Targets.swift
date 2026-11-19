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

  /// Every on-screen window under `point` (global, top-left), topmost first: this app's own among them, its status
  /// item and its menus in the menu bar too, so a click on them is seen for what it is.
  static func windows(at point: CGPoint) -> [WindowHit] {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else { return [] }
    return windows.compactMap { window in
      guard let pid = window[kCGWindowOwnerPID as String] as? pid_t,
            let number = window[kCGWindowNumber as String] as? Int,
            let bounds = window[kCGWindowBounds as String] as? NSDictionary,
            let frame = CGRect(dictionaryRepresentation: bounds), frame.contains(point) else { return nil }
      return WindowHit(pid: pid, number: number, clear: (window[kCGWindowAlpha as String] as? Double ?? 1) <= 0)
    }
  }

  /// macOS turns secure input on while a password field has focus, and keeps keystrokes from other apps' eyes.
  /// Asked from any thread: the selection is read off the main one.
  nonisolated static var passwordFieldHasFocus: Bool {
    IsSecureEventInputEnabled()
  }
}
