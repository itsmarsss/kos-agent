import Foundation

/// What Accessibility is asked of the field in focus and of what is under a point, behind a seam so the rules are
/// tested. Never a field's value: AXValue is never asked.
public protocol FieldAccess: AnyObject {
  associatedtype Element: Equatable
  /// The element with keyboard focus in the app with this pid.
  func focused(pid: Int32) -> Element?
  /// The element a click at this point (global points, top-left origin) would reach.
  func element(at point: Point) -> Element?
  func string(_ attribute: String, of element: Element) -> String?
  func element(_ attribute: String, of element: Element) -> Element?
  /// An address attribute (AXURL, AXDocument), as text.
  func url(_ attribute: String, of element: Element) -> String?
  /// A number attribute (AXNumberOfCharacters, AXMenuItemCmdModifiers): a count or flags, never a value.
  func number(_ attribute: String, of element: Element) -> Int?
  /// The length of the element's selected range (AXSelectedTextRange), never its text.
  func selectedLength(of element: Element) -> Int?
  /// Where the element is, in global points, top-left origin; nil when it is gone or will not say.
  func frame(of element: Element) -> Rect?
}

/// Where a field is: in an app's own window, on a web page whose every frame was read, or on a page KOS cannot vouch
/// for, which takes no secret.
public enum FieldPlace: Equatable, Sendable {
  case app
  /// `origin` is the top page's; `frames` the origins of the frames between it and the field, outermost first, those
  /// on the top page's own origin left out.
  case page(origin: String, frames: [String])
  /// On a page whose address is not http or https or could not be read, or too deep to find the top of.
  case unknown
}

/// An element's place, with the web area at its top and the address that area was at when it was read.
struct PlaceWalk<Element> {
  let place: FieldPlace
  let top: Element?
  let address: String?
}

/// Reading where an element is: walked up to its window, every web area on the way read.
enum PagePlace {
  /// How far up from an element its window is looked for; past it, where it is cannot be said.
  static var parents: Int { 64 }
  static var webArea: String { "AXWebArea" }

  static func walk<Access: FieldAccess>(_ element: Access.Element, _ access: Access) -> PlaceWalk<Access.Element> {
    var at: Access.Element? = element
    var areas: [(element: Access.Element, address: String?)] = []
    var reachedTop = false
    for _ in 0..<parents {
      guard let e = at else {
        reachedTop = true
        break
      }
      let role = access.string("AXRole", of: e)
      if role == webArea { areas.append((e, address(of: e, access))) }
      if role == "AXWindow" || role == "AXApplication" {
        reachedTop = true
        break
      }
      at = access.element("AXParent", of: e)
    }
    guard reachedTop else { return PlaceWalk(place: .unknown, top: nil, address: nil) }
    guard let top = areas.last else { return PlaceWalk(place: .app, top: nil, address: nil) }
    let origins = areas.map { $0.address.flatMap(originOf) }
    guard let pageOrigin = origins.last ?? nil, !origins.contains(nil) else {
      return PlaceWalk(place: .unknown, top: top.element, address: top.address)
    }
    var frames: [String] = []
    for origin in origins.dropLast().reversed().compactMap({ $0 }) where origin != pageOrigin && !frames.contains(origin) {
      frames.append(origin)
    }
    return PlaceWalk(place: .page(origin: pageOrigin, frames: frames), top: top.element, address: top.address)
  }

  /// A web area's address: AXURL, else AXDocument, which some browsers fill instead.
  static func address<Access: FieldAccess>(of area: Access.Element, _ access: Access) -> String? {
    access.url("AXURL", of: area) ?? access.url("AXDocument", of: area)
  }

  /// An http or https address's origin, lowercased; nil for any other scheme or one that does not parse.
  static func originOf(_ address: String) -> String? {
    guard let url = URL(string: address), let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased(), !host.isEmpty,
          scheme == "https" || scheme == "http" else { return nil }
    let port = url.port.map { ":\($0)" } ?? ""
    return "\(scheme)://\(host)\(port)"
  }

  /// The schemes of a browser extension's own pages, KOS for Chrome's panel among them.
  static var extensionSchemes: Set<String> { ["chrome-extension", "moz-extension", "safari-web-extension", "extension"] }
  static var loopback: Set<String> { ["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"] }

  /// Why a page at this address is one KOS never acts on, if it is: a browser extension's own page, or KOS's own
  /// dashboard (any of `dashboards`, a loopback one on any loopback name at its port), where an approval is decided.
  static func ownPage(_ address: String?, dashboards: [String]) -> String? {
    guard let address, let url = URL(string: address), let scheme = url.scheme?.lowercased() else { return nil }
    if extensionSchemes.contains(scheme) {
      return "That is a browser extension's own page (KOS for Chrome's panel among them), which KOS never acts on."
    }
    guard let host = url.host?.lowercased(), scheme == "http" || scheme == "https" else { return nil }
    let port = url.port ?? (scheme == "https" ? 443 : 80)
    for dashboard in dashboards {
      guard let d = URL(string: dashboard), let dHost = d.host?.lowercased(), let dScheme = d.scheme?.lowercased() else { continue }
      let dPort = d.port ?? (dScheme == "https" ? 443 : 80)
      let sameHost = host == dHost || (loopback.contains(host) && loopback.contains(dHost))
      if sameHost && port == dPort {
        return "That is KOS's own dashboard, where approvals are decided; KOS never acts on it."
      }
    }
    return nil
  }

  /// Why an element is on a page KOS never acts on, if it is: any web area it is in, walked up to its window.
  static func ownPage<Access: FieldAccess>(of element: Access.Element, _ access: Access, dashboards: [String]) -> String? {
    var at: Access.Element? = element
    for _ in 0..<parents {
      guard let e = at else { return nil }
      let role = access.string("AXRole", of: e)
      if role == webArea, let refusal = ownPage(address(of: e, access), dashboards: dashboards) { return refusal }
      if role == "AXWindow" || role == "AXApplication" { return nil }
      at = access.element("AXParent", of: e)
    }
    return nil
  }
}
