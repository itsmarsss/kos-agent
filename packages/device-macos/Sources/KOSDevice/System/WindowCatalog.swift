import AppKit
import ApplicationServices
import ScreenCaptureKit

/// The windows the owner can hand KOS instead of the whole screen, as a
/// screen-sharing picker offers them: someone else's ordinary windows, on
/// screen, not too small to work in, and not an app on the hidden list.
@MainActor
enum WindowCatalog {
  struct Entry: Equatable {
    let id: CGWindowID
    let pid: pid_t
    let app: String
    let bundle: String
    let title: String
    /// Global points, top-left origin.
    let frame: CGRect
  }

  private static let smallest = CGSize(width: 120, height: 80)

  static func windows(hiding settings: Settings) async -> [Entry] {
    guard let content = try? await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true) else { return [] }
    let me = getpid()
    return content.windows.compactMap { window in
      guard window.windowLayer == 0, window.isOnScreen, let app = window.owningApplication, app.processID != me,
            !settings.isHidden(app.bundleIdentifier), window.frame.width >= smallest.width, window.frame.height >= smallest.height
      else { return nil }
      return Entry(
        id: window.windowID, pid: app.processID, app: app.applicationName, bundle: app.bundleIdentifier,
        title: window.title ?? "", frame: window.frame)
    }
  }

  /// A window's frame now, or nothing when it has closed.
  static func frame(of id: CGWindowID) -> CGRect? {
    guard let info = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]],
          let bounds = info.first?[kCGWindowBounds as String] as? NSDictionary else { return nil }
    return CGRect(dictionaryRepresentation: bounds)
  }

  /// A small picture of one window, for the picker.
  static func thumbnail(of id: CGWindowID, width: Int = 320) async -> NSImage? {
    guard let content = try? await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true),
          let window = content.windows.first(where: { $0.windowID == id }) else { return nil }
    return await picture(SCContentFilter(desktopIndependentWindow: window), size: window.frame.size, width: width)
  }

  /// A small picture of a display, without this app's own windows, for the picker's "Entire screen".
  static func thumbnail(display id: CGDirectDisplayID, width: Int = 320) async -> NSImage? {
    guard let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true),
          let display = content.displays.first(where: { $0.displayID == id }) else { return nil }
    let me = content.applications.filter { $0.processID == getpid() }
    let filter = SCContentFilter(display: display, excludingApplications: me, exceptingWindows: [])
    return await picture(filter, size: CGSize(width: display.width, height: display.height), width: width)
  }

  private static func picture(_ filter: SCContentFilter, size: CGSize, width: Int) async -> NSImage? {
    let config = SCStreamConfiguration()
    config.width = width
    config.height = max(1, Int(CGFloat(width) * size.height / max(size.width, 1)))
    config.showsCursor = false
    guard let image = try? await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) else { return nil }
    return NSImage(cgImage: image, size: NSSize(width: image.width, height: image.height))
  }

  /// Brings the window to the front of its app and the app to the front, so what KOS does lands on it.
  static func raise(_ entry: Entry) async {
    let app = NSRunningApplication(processIdentifier: entry.pid)
    if NSWorkspace.shared.frontmostApplication?.processIdentifier != entry.pid {
      app?.activate()
    }
    let element = AXUIElementCreateApplication(entry.pid)
    let now = frame(of: entry.id) ?? entry.frame
    var value: CFTypeRef?
    if AXUIElementCopyAttributeValue(element, kAXWindowsAttribute as CFString, &value) == .success, let windows = value as? [AXUIElement] {
      // The AX window whose frame is this window's: the one to raise.
      for window in windows where axFrame(window) == now {
        AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        break
      }
    }
    // A moment for the window server to finish the reorder before an event lands on it.
    try? await Task.sleep(nanoseconds: 120_000_000)
  }

  /// Whether the window is the topmost ordinary window, so nothing covers it.
  static func isFront(_ id: CGWindowID) -> Bool {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return false }
    let me = getpid()
    let first = list.first { ($0[kCGWindowLayer as String] as? Int) == 0 && ($0[kCGWindowOwnerPID as String] as? pid_t) != me }
    return (first?[kCGWindowNumber as String] as? CGWindowID) == id
  }

  private static func axFrame(_ window: AXUIElement) -> CGRect? {
    var position: CFTypeRef?
    var size: CFTypeRef?
    guard AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &position) == .success,
          AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &size) == .success,
          let position, let size, CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID()
    else { return nil }
    var point = CGPoint.zero
    var extent = CGSize.zero
    AXValueGetValue(position as! AXValue, .cgPoint, &point)
    AXValueGetValue(size as! AXValue, .cgSize, &extent)
    return CGRect(origin: point, size: extent)
  }
}
