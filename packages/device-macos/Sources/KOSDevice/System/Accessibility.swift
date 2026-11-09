import ApplicationServices
import DeviceCore

/// SelectionAccess over the system's Accessibility API.
@MainActor
final class Accessibility: SelectionAccess {
  /// How long an app is given to answer each question: one that does not is not waited on.
  private static let timeout: Float = 0.25

  private(set) var answering = true

  var trusted: Bool { AXIsProcessTrusted() }

  func application(_ pid: Int32) -> AXUIElement {
    answering = true
    return timed(AXUIElementCreateApplication(pid))
  }

  func element(_ attribute: String, of element: AXUIElement) -> AXUIElement? {
    guard let value = copy(attribute, of: element), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return timed(value as! AXUIElement)
  }

  func string(_ attribute: String, of element: AXUIElement) -> String? {
    copy(attribute, of: element) as? String
  }

  func bool(_ attribute: String, of element: AXUIElement) -> Bool? {
    copy(attribute, of: element) as? Bool
  }

  func set(_ attribute: String, _ value: Bool, on element: AXUIElement) -> Bool {
    AXUIElementSetAttributeValue(element, attribute as CFString, value as CFBoolean) == .success
  }

  func markedText(of element: AXUIElement) -> String? {
    guard let range = copy("AXSelectedTextMarkerRange", of: element) else { return nil }
    var value: CFTypeRef?
    let result = note(AXUIElementCopyParameterizedAttributeValue(element, "AXStringForTextMarkerRange" as CFString, range, &value))
    return result == .success ? value as? String : nil
  }

  func children(of element: AXUIElement) -> [AXUIElement] {
    (copy(kAXChildrenAttribute, of: element) as? [AXUIElement] ?? []).map(timed)
  }

  private func copy(_ attribute: String, of element: AXUIElement) -> CFTypeRef? {
    var value: CFTypeRef?
    return note(AXUIElementCopyAttributeValue(element, attribute as CFString, &value)) == .success ? value : nil
  }

  private func timed(_ element: AXUIElement) -> AXUIElement {
    AXUIElementSetMessagingTimeout(element, Self.timeout)
    return element
  }

  /// An app that timed out once is asked nothing more on this read.
  private func note(_ result: AXError) -> AXError {
    if result == .cannotComplete { answering = false }
    return result
  }
}
