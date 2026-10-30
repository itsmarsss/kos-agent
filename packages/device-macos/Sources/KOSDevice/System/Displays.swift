import AppKit
import DeviceCore

/// The displays, and the one conversion everything here needs.
///
/// CoreGraphics (events, captures) puts the origin at the top left of the
/// main display; AppKit (windows) puts it at the bottom left. Every
/// crossing between the two goes through `cocoa(_:)`.
enum Displays {
  static func info() -> [DisplayInfo] {
    NSScreen.screens.map { screen in
      DisplayInfo(
        id: screen.displayID, width: screen.frame.width, height: screen.frame.height,
        scale: screen.backingScaleFactor, main: screen.displayID == CGMainDisplayID())
    }
  }

  /// The display the pointer is on: where the owner is looking.
  static func underCursor() -> CGDirectDisplayID {
    var id = CGMainDisplayID()
    var count: UInt32 = 0
    _ = CGGetDisplaysWithPoint(cursor(), 1, &id, &count)
    return count > 0 ? id : CGMainDisplayID()
  }

  static func screen(for id: CGDirectDisplayID) -> NSScreen? {
    NSScreen.screens.first { $0.displayID == id }
  }

  /// A display's frame in global points, top-left origin.
  static func bounds(_ id: CGDirectDisplayID) -> Rect {
    Rect(CGDisplayBounds(id))
  }

  /// The pointer, in global points, top-left origin.
  static func cursor() -> CGPoint {
    CGEvent(source: nil)?.location ?? .zero
  }

  /// A top-left global rect as AppKit's bottom-left screen rect.
  static func cocoa(_ rect: CGRect) -> CGRect {
    let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
    return CGRect(x: rect.minX, y: primaryHeight - rect.maxY, width: rect.width, height: rect.height)
  }
}

extension NSScreen {
  var displayID: CGDirectDisplayID {
    (deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? 0
  }
}

extension Rect {
  init(_ rect: CGRect) {
    self.init(x: rect.minX, y: rect.minY, width: rect.width, height: rect.height)
  }

  var cg: CGRect { CGRect(x: x, y: y, width: width, height: height) }
}

extension Point {
  init(_ point: CGPoint) {
    self.init(x: point.x, y: point.y)
  }

  var cg: CGPoint { CGPoint(x: x, y: y) }
}
