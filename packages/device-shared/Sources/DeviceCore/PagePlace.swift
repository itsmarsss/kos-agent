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

/// Web browsers on a Mac, by bundle id: their fields are on pages, which take a secret only on an origin. Kept as
/// KOS's own list (records.ts, isBrowserApp): an entry ending in a dot covers every id under it, any other an id and
/// those under it (Chrome's channels and web app shims).
public enum Browsers {
  static var prefixes: [String] {
    [
      "com.apple.Safari", "com.apple.SafariTechnologyPreview", "com.google.Chrome", "org.chromium.", "org.mozilla.",
      "com.microsoft.edgemac", "com.brave.Browser", "company.thebrowser.", "com.operasoftware.", "com.vivaldi.",
      "com.kagi.kagimacOS", "app.zen-browser.", "org.torproject.", "com.duckduckgo.macos.browser", "net.waterfox.",
    ]
  }

  public static func contains(_ bundle: String?) -> Bool {
    guard let bundle else { return false }
    return prefixes.contains { $0.hasSuffix(".") ? bundle.hasPrefix($0) : bundle == $0 || bundle.hasPrefix($0 + ".") }
  }
}

/// Reading where an element is: walked up to its window, every web area on the way read.
public enum PagePlace {
  /// How far up from an element its window is looked for; past it, where it is cannot be said.
  static var parents: Int { 64 }
  static var webArea: String { "AXWebArea" }

  /// How a walk up ended: at the element's window (or the app), at an element with no parent short of it, or at the
  /// limit.
  enum WalkEnd {
    case top, orphan, limit
  }

  /// The web areas from the element up, and how the walk ended.
  static func areas<Access: FieldAccess>(above element: Access.Element, _ access: Access) -> (areas: [(element: Access.Element, address: String?)], end: WalkEnd) {
    var at: Access.Element? = element
    var areas: [(element: Access.Element, address: String?)] = []
    for _ in 0..<parents {
      guard let e = at else { return (areas, .orphan) }
      let role = access.string("AXRole", of: e)
      if role == webArea { areas.append((e, address(of: e, access))) }
      if role == "AXWindow" || role == "AXApplication" { return (areas, .top) }
      at = access.element("AXParent", of: e)
    }
    return (areas, .limit)
  }

  /// Where the element is. In a browser every web area is a page. In any other app a web area at an address that is
  /// not http or https (file:, its own scheme) is the app's own window drawn as one; one at http or https is a page.
  /// A walk that runs out is unknown. A page whose window is not reached (a parent missing on the way), or one whose
  /// address is not read or not http or https, is unknown.
  static func walk<Access: FieldAccess>(_ element: Access.Element, _ access: Access, browser: Bool) -> PlaceWalk<Access.Element> {
    let (all, end) = areas(above: element, access)
    guard end != .limit else { return PlaceWalk(place: .unknown, top: nil, address: nil) }
    let pages = browser ? all : all.filter { $0.address.map { originOf($0) != nil } ?? true }
    guard let top = pages.last else { return PlaceWalk(place: .app, top: nil, address: nil) }
    let origins = pages.map { $0.address.flatMap(originOf) }
    guard end == .top, let pageOrigin = origins.last ?? nil, !origins.contains(nil) else {
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

  /// A KOS's address as one of its own hosts, `host:port`, the scheme's port when it names none.
  public static func hostEntry(of address: String) -> String? {
    guard let url = URL(string: address), let host = url.host?.lowercased(), let scheme = url.scheme?.lowercased() else { return nil }
    return "\(url.host?.contains(":") == true ? "[\(host)]" : host):\(url.port ?? (scheme == "https" ? 443 : 80))"
  }

  /// The schemes of a browser extension's own pages, KOS for Chrome's panel among them.
  static var extensionSchemes: Set<String> { ["chrome-extension", "moz-extension", "safari-web-extension", "extension"] }
  static var loopback: Set<String> { ["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"] }

  /// Why a page at this address is one KOS never acts on, if it is: a browser extension's own page, or KOS's own
  /// dashboard. `hosts` are KOS's own, each `host:port` (a loopback one on any loopback name at that port) or a bare
  /// host on any port, as KOS sends them (session.begin `kosHosts`) and the pairings name them.
  static func ownPage(_ address: String?, hosts: [String]) -> String? {
    guard let address, let url = URL(string: address), let scheme = url.scheme?.lowercased() else { return nil }
    if extensionSchemes.contains(scheme) {
      return "That is a browser extension's own page (KOS for Chrome's panel among them), which KOS never acts on."
    }
    guard let raw = url.host?.lowercased(), scheme == "http" || scheme == "https" else { return nil }
    let host = raw.contains(":") ? "[\(raw)]" : raw
    let port = url.port ?? (scheme == "https" ? 443 : 80)
    for entry in hosts {
      guard let own = URL(string: "http://\(entry.lowercased())"), let ownRaw = own.host else { continue }
      let ownHost = ownRaw.contains(":") ? "[\(ownRaw)]" : ownRaw
      let matches: Bool
      if let ownPort = own.port {
        matches = ownPort == port && (host == ownHost || (loopback.contains(host) && loopback.contains(ownHost)))
      } else {
        matches = host == ownHost && !loopback.contains(ownHost)
      }
      if matches { return "That is KOS's own dashboard, where approvals are decided; KOS never acts on it." }
    }
    return nil
  }

  /// Why an element is on a page KOS never acts on, if it is: any web area it is in, walked up to its window. In a
  /// browser, a walk that does not reach the window cannot say it is not, so it is refused.
  static func ownPage<Access: FieldAccess>(of element: Access.Element, _ access: Access, hosts: [String], browser: Bool) -> String? {
    let (areas, end) = areas(above: element, access)
    for area in areas {
      if let refusal = ownPage(area.address, hosts: hosts) { return refusal }
    }
    if browser, end != .top {
      return "KOS cannot tell which page that is in the browser, so it does not act there: it may be KOS's own dashboard."
    }
    return nil
  }
}
