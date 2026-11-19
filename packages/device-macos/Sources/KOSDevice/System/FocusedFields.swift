import ApplicationServices
import DeviceCore

/// FieldAccess over the system's Accessibility API: the field in focus in an app, what it is and where, and the menu
/// item under a point. Never a field's value: AXValue is not read here.
final class FocusedFields: FieldAccess {
  /// How long an app is given to answer each question, so one that hangs cannot hold a call.
  private static let timeout: Float = 0.1

  func focused(pid: Int32) -> AXUIElement? {
    element(kAXFocusedUIElementAttribute, of: timed(AXUIElementCreateApplication(pid)))
  }

  func string(_ attribute: String, of element: AXUIElement) -> String? {
    copy(attribute, of: element) as? String
  }

  func element(_ attribute: String, of element: AXUIElement) -> AXUIElement? {
    guard let value = copy(attribute, of: element), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return timed(value as! AXUIElement)
  }

  func url(_ attribute: String, of element: AXUIElement) -> String? {
    guard let value = copy(attribute, of: element) else { return nil }
    if CFGetTypeID(value) == CFURLGetTypeID() { return (value as! URL).absoluteString }
    return value as? String
  }

  func frame(of element: AXUIElement) -> Rect? {
    guard let position = copy(kAXPositionAttribute, of: element), let size = copy(kAXSizeAttribute, of: element),
          CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    var extent = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &extent),
          extent.width > 0, extent.height > 0 else { return nil }
    return Rect(x: point.x, y: point.y, width: extent.width, height: extent.height)
  }

  /// The menu item at a point on the screen (global, top-left), as a click there would pick it: its role, its key
  /// equivalent and its title. Nil when there is nothing there Accessibility will name.
  func menuItem(at point: CGPoint) -> (role: String?, commandKey: String?, title: String?)? {
    var found: AXUIElement?
    let wide = timed(AXUIElementCreateSystemWide())
    guard AXUIElementCopyElementAtPosition(wide, Float(point.x), Float(point.y), &found) == .success, let found else { return nil }
    let item = timed(found)
    return (string(kAXRoleAttribute, of: item), string(kAXMenuItemCmdCharAttribute, of: item), string(kAXTitleAttribute, of: item))
  }

  private func copy(_ attribute: String, of element: AXUIElement) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success ? value : nil
  }

  private func timed(_ element: AXUIElement) -> AXUIElement {
    AXUIElementSetMessagingTimeout(element, Self.timeout)
    return element
  }
}
