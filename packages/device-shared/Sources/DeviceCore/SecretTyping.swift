import Foundation

// A saved secret typed on this Mac (docs/secrets.md, KOS for Mac): the rules
// keys.secret is held to, the field it goes into as Accessibility describes
// it (never its value), the buffer the value is typed from and zeroed after,
// and what the fields KOS typed into keep from the pictures and the keys
// that follow. Everything here is Foundation alone, behind seams for
// Accessibility and the keyboard, so every rule is tested.

/// What Accessibility is asked of the field in focus, behind a seam so the rules are tested. Never its value.
public protocol FieldAccess: AnyObject {
  associatedtype Element: Equatable
  /// The element with keyboard focus in the app with this pid.
  func focused(pid: Int32) -> Element?
  func string(_ attribute: String, of element: Element) -> String?
  func element(_ attribute: String, of element: Element) -> Element?
  /// An address attribute (AXURL), as text.
  func url(_ attribute: String, of element: Element) -> String?
  /// Where the element is, in global points, top-left origin; nil when it is gone or will not say.
  func frame(of element: Element) -> Rect?
}

/// The field in focus, as KOS is told it and the owner approves it: what it is, never what it holds.
public struct FieldIdentity: Codable, Equatable, Sendable {
  /// AXTextField or AXTextArea.
  public let role: String
  /// A password field (AXSecureTextField), whose characters the app never shows.
  public let secure: Bool
  /// The title of the window it is in.
  public let window: String?
  /// What the app calls it (AXTitle or AXDescription), and the hint it shows while empty (AXPlaceholderValue).
  public let label: String?
  public let placeholder: String?
  /// The origin of the web page it is in, for a field on a page in a browser.
  public let origin: String?

  public init(role: String, secure: Bool, window: String? = nil, label: String? = nil, placeholder: String? = nil, origin: String? = nil) {
    self.role = role
    self.secure = secure
    self.window = window
    self.label = label
    self.placeholder = placeholder
    self.origin = origin
  }
}

/// keys.focus's answer: the app in front and the field in focus there, when there is one.
public struct FocusResult: Encodable, Sendable {
  public let app: FrontApp?
  public let field: FieldIdentity?

  public init(app: FrontApp?, field: FieldIdentity?) {
    self.app = app
    self.field = field
  }
}

/// What the owner approved a secret for: the app and the field, as keys.focus said them when they were asked.
public struct ExpectedField: Decodable, Equatable, Sendable {
  public let role: String
  public let secure: Bool
  public let window: String?

  public init(role: String, secure: Bool, window: String?) {
    self.role = role
    self.secure = secure
    self.window = window
  }
}

public struct SecretApp: Decodable, Equatable, Sendable {
  public let bundle: String

  public init(bundle: String) {
    self.bundle = bundle
  }
}

/// keys.secret's params. `text` is the value: read once into a SecretBuffer and never kept, logged or echoed.
public struct SecretTypeParams: Decodable, Sendable {
  public let session: String
  /// The session the owner approved the secret's use in: the live one, or nothing is typed.
  public let approved: String
  public let text: String
  /// What kind of field it goes into, as KOS names it: password, username, card-number, card-cvc, token, text, ...
  public let field: String
  /// The app it was approved into, and every app the secret may be typed into.
  public let app: SecretApp
  public let apps: [String]
  public let expect: ExpectedField
  /// The page's origin, for a field on a page in a browser.
  public let origin: String?

  public init(session: String, approved: String, text: String, field: String, app: SecretApp, apps: [String], expect: ExpectedField, origin: String? = nil) {
    self.session = session
    self.approved = approved
    self.text = text
    self.field = field
    self.app = app
    self.apps = apps
    self.expect = expect
    self.origin = origin
  }
}

/// keys.secret's answer: that it was typed, and nothing else. No cursor, no field, no echo.
public struct SecretTypedResult: Encodable, Equatable, Sendable {
  public let typed = true

  public init() {}
}

/// A secret's value, typed from here and zeroed once typed, whether it was typed or not.
///
/// A Swift String cannot be wiped, so the frame the value came in, and the
/// params decoded from it, still hold it until they are freed: a known limit,
/// as for a JavaScript string on KOS's side. What this keeps is the one copy
/// the typing works from, and each chunk is posted straight from it.
public final class SecretBuffer {
  private var units: [UInt16]

  public init(_ text: String) {
    units = Array(text.utf16)
  }

  deinit {
    wipe()
  }

  public var count: Int { units.count }
  public var isWiped: Bool { units.allSatisfy { $0 == 0 } }

  /// Every unit overwritten with zero, through memset_s, which the compiler may not drop.
  public func wipe() {
    units.withUnsafeMutableBytes { bytes in
      guard let base = bytes.baseAddress else { return }
      _ = memset_s(base, bytes.count, 0, bytes.count)
    }
  }

  /// The chunks it is typed in: at most `size` units each, never splitting a character's surrogate pair.
  func chunks(of size: Int) -> [Range<Int>] {
    var ranges: [Range<Int>] = []
    var start = 0
    while start < units.count {
      var end = min(start + size, units.count)
      if end < units.count, end - start > 1, UTF16.isLeadSurrogate(units[end - 1]) { end -= 1 }
      ranges.append(start..<end)
      start = end
    }
    return ranges
  }

  func with<T>(_ range: Range<Int>, _ body: (UnsafeBufferPointer<UInt16>) throws -> T) rethrows -> T {
    try units.withUnsafeBufferPointer { try body(UnsafeBufferPointer(rebasing: $0[range])) }
  }

  /// Characters that would act rather than type (Return, Tab), which a secret is never typed with.
  var hasControls: Bool {
    units.contains { $0 < 0x20 || $0 == 0x7F }
  }
}

/// What is in front as a secret is typed, read afresh before each chunk: the app and its pid, whether it is KOS for
/// Mac itself (one of its windows has the keyboard, or its menu is open), and whether it is on the hidden list.
public struct SecretScene: Sendable {
  public let front: FrontApp?
  public let pid: Int32?
  public let own: Bool
  public let hidden: Bool

  public init(front: FrontApp?, pid: Int32?, own: Bool, hidden: Bool) {
    self.front = front
    self.pid = pid
    self.own = own
    self.hidden = hidden
  }
}

/// The rules keys.secret is held to, the field it goes into read through Accessibility, and the fields typed into.
///
/// Before typing: the session is live and the one approved; KOS for Mac's own
/// window does not have the keyboard; the app in front is the one approved,
/// one the secret allows and not hidden; the field in focus is a text field
/// (never a search field), the one approved (its role, whether it is a
/// password field, its window), of the kind the secret goes into (a password
/// only into a password field; a card's number or code only where the
/// field's label or hint, when it has one, says so), and on the page's site
/// in a browser. Then it is typed as unicode, in chunks, from a buffer
/// zeroed after, and the field is kept: a picture blacks it out, and copying
/// out of it or typing into it again is refused for the rest of the session.
public final class SecretDesk<Access: FieldAccess> {
  private let access: Access
  /// The fields typed into, for the session they were typed in.
  private var typed: [Access.Element] = []
  private var session: String?

  /// Things that answer to these roles are typed into; a search field never is.
  static var typeable: Set<String> { ["AXTextField", "AXTextArea", "AXComboBox"] }
  static var secureRole: String { "AXSecureTextField" }
  static var searchRole: String { "AXSearchField" }
  /// How far up from the field a web page's area is looked for.
  static var parents: Int { 24 }

  public init(_ access: Access) {
    self.access = access
  }

  // MARK: The field

  /// The field in focus in the app with this pid, as keys.focus answers it; nil when none is a text field.
  public func describe(pid: Int32) -> FieldIdentity? {
    access.focused(pid: pid).flatMap(identity)
  }

  func identity(of element: Access.Element) -> FieldIdentity? {
    let role = access.string("AXRole", of: element) ?? ""
    let subrole = access.string("AXSubrole", of: element)
    let secure = role == Self.secureRole || subrole == Self.secureRole
    guard secure || Self.typeable.contains(role), subrole != Self.searchRole else { return nil }
    let window = access.element("AXWindow", of: element).flatMap { access.string("AXTitle", of: $0) }
    let label = [access.string("AXTitle", of: element), access.string("AXDescription", of: element)]
      .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }.first { !$0.isEmpty }
    let placeholder = access.string("AXPlaceholderValue", of: element)?.trimmingCharacters(in: .whitespacesAndNewlines)
    return FieldIdentity(
      role: secure ? "AXTextField" : role, secure: secure, window: window, label: label,
      placeholder: placeholder?.isEmpty == false ? placeholder : nil, origin: origin(of: element))
  }

  /// The origin of the web area the element is in, when it is in one.
  private func origin(of element: Access.Element) -> String? {
    var at: Access.Element? = element
    for _ in 0..<Self.parents {
      guard let e = at else { return nil }
      if access.string("AXRole", of: e) == "AXWebArea" {
        return access.url("AXURL", of: e).flatMap(Self.originOf)
      }
      if access.string("AXRole", of: e) == "AXWindow" { return nil }
      at = access.element("AXParent", of: e)
    }
    return nil
  }

  static func originOf(_ address: String) -> String? {
    guard let url = URL(string: address), let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased(),
          scheme == "https" || scheme == "http" else { return nil }
    let port = url.port.map { ":\($0)" } ?? ""
    return "\(scheme)://\(host)\(port)"
  }

  // MARK: Typing

  /// Every check, then the value (`buffer`, read from the params' text) typed through `post` a chunk at a time with
  /// `between` after each, and the field kept. The checks run again before every chunk and after the last, on the
  /// scene as it is then: the first that fails stops the typing, and the field is kept all the same if any of it
  /// went in. The buffer is zeroed whatever happens. A refusal names what is wrong, never the value.
  public func type(
    _ params: SecretTypeParams, buffer: SecretBuffer, live: String, scene: () -> SecretScene,
    post: (UnsafeBufferPointer<UInt16>) throws -> Void, between: () async throws -> Void
  ) async throws -> SecretTypedResult {
    defer { buffer.wipe() }
    let field = try check(params, buffer: buffer, live: live, scene: scene())
    var begun = false
    defer {
      if begun { note(field, session: live) }
    }
    func still() throws {
      guard try check(params, buffer: buffer, live: live, scene: scene()) == field else {
        throw DeviceError(.field, "Focus moved to another field while the secret was typed; the rest was not typed.")
      }
    }
    for range in buffer.chunks(of: Typing.chunkUnits) {
      if begun { try still() }
      begun = true
      try buffer.with(range, post)
      try await between()
    }
    try still()
    return SecretTypedResult()
  }

  private func check(_ p: SecretTypeParams, buffer: SecretBuffer, live: String, scene: SecretScene) throws -> Access.Element {
    guard p.approved == live, p.session == live else {
      throw DeviceError(.noSession, "This is not the session the owner approved the secret in.")
    }
    guard buffer.count > 0 else { throw DeviceError.badRequest("The secret has nothing saved to type.") }
    guard buffer.count <= Limits.typedCharacters else { throw DeviceError.badRequest("The secret is too long to type.") }
    guard !buffer.hasControls else { throw DeviceError.badRequest("The secret holds a line break or a tab, which would act rather than type.") }
    guard !scene.own else { throw DeviceError(.target, "KOS for Mac itself is in front; a secret is never typed into its windows or its menu.") }
    guard let front = scene.front, let pid = scene.pid else { throw DeviceError(.target, "No app is in front.") }
    guard !scene.hidden else { throw DeviceError(.hiddenApp, "\(front.name) is hidden from KOS on this Mac.") }
    guard front.bundle == p.app.bundle else {
      throw DeviceError(.target, "\(front.name) is in front, not the app the owner approved.")
    }
    guard p.apps.contains(front.bundle) else { throw DeviceError(.target, "The secret is not allowed in \(front.name).") }
    guard let element = access.focused(pid: pid), let field = identity(of: element) else {
      throw DeviceError(.field, "No text field has focus in \(front.name).")
    }
    guard field.role == p.expect.role, field.secure == p.expect.secure, field.window == p.expect.window else {
      throw DeviceError(.field, "The field with focus is not the one the owner approved.")
    }
    if let refusal = Self.refusal(of: p.field, into: field) { throw DeviceError(.field, refusal) }
    if field.origin != p.origin {
      throw DeviceError(.origin, field.origin == nil ? "The field is not on the page the owner approved." : "The page in front is not on the site the owner approved.")
    }
    return element
  }

  /// Why a secret's field may not go into this one, if it may not: a password only into a password field, a card's
  /// number and code only where the field's own words, when it has any, say so.
  static func refusal(of kind: String, into field: FieldIdentity) -> String? {
    let words = [field.label, field.placeholder].compactMap { $0?.lowercased() }.joined(separator: " ")
    switch kind {
    case "password":
      return field.secure ? nil : "A password goes only into a password field, and this one shows what is typed."
    case "card-number":
      return words.isEmpty || words.range(of: #"card|number|credit|debit|\bcc\b|\bpan\b"#, options: .regularExpression) != nil
        ? nil : "The field does not say it takes a card number."
    case "card-cvc":
      return words.isEmpty || words.range(of: #"cvc|cvv|csc|cid|security"#, options: .regularExpression) != nil
        ? nil : "The field does not say it takes a card's security code."
    default:
      return nil
    }
  }

  // MARK: The fields typed into

  private func note(_ element: Access.Element, session: String) {
    if self.session != session {
      typed = []
      self.session = session
    }
    if !typed.contains(element) { typed.append(element) }
  }

  /// The session ended: what it typed into is no longer kept.
  public func end() {
    typed = []
    session = nil
  }

  /// Whether the field in focus in this app is one KOS typed a secret into this session.
  public func typedHasFocus(pid: Int32?) -> Bool {
    guard let pid, !typed.isEmpty, let focused = access.focused(pid: pid) else { return false }
    return typed.contains(focused)
  }

  /// What a picture blacks out, in global points: every field typed into that can be found, and a password field
  /// in focus. Refused (secret_field) while either is in focus and cannot be found.
  public func masks(pid: Int32?) throws -> [Rect] {
    let focused = pid.flatMap { access.focused(pid: $0) }
    var rects: [Rect] = []
    for element in typed {
      if let frame = access.frame(of: element) {
        rects.append(frame)
      } else if element == focused {
        throw DeviceError(.secretField, "A field KOS typed a secret into has focus and cannot be found, so no picture is taken.")
      }
    }
    if let focused, !typed.contains(focused), identity(of: focused)?.secure == true {
      guard let frame = access.frame(of: focused) else {
        throw DeviceError(.secretField, "A password field has focus and cannot be found, so no picture is taken.")
      }
      rects.append(frame)
    }
    return rects
  }

  /// keys.type, refused into a field KOS typed a secret into.
  public func refuseTyping(pid: Int32?) throws {
    if typedHasFocus(pid: pid) {
      throw DeviceError(.secretField, "KOS typed a secret into the field with focus; it types nothing more there.")
    }
  }

  /// keys.press with a field KOS typed a secret into in focus: only moving on from it (Return, Enter, Tab,
  /// shift-Tab, Escape), never copying, cutting, selecting all, pasting or editing. True when the press may go
  /// through though a password field has focus.
  public func allowsPress(_ combo: KeyCombo, pid: Int32?) throws -> Bool {
    guard typedHasFocus(pid: pid) else { return false }
    let moving: Set<UInt16> = [36, 76, 48, 53]
    let mods = combo.modifiers.subtracting(.shift)
    guard moving.contains(combo.code), mods.isEmpty, combo.modifiers.isEmpty || combo.code == 48 else {
      throw DeviceError(.secretField, "KOS typed a secret into the field with focus: it only moves on from it there (Return, Tab, Escape), and copies nothing out.")
    }
    return true
  }

  /// A click on a menu's Copy, Cut, Select All or Paste while a field KOS typed a secret into has focus: refused.
  /// The item is known by its key equivalent (AXMenuItemCmdChar with Command), else its English title.
  public func refuseMenuItem(role: String?, commandKey: String?, title: String?, pid: Int32?) throws {
    guard role == "AXMenuItem", typedHasFocus(pid: pid) else { return }
    let key = commandKey?.lowercased()
    let named = title?.trimmingCharacters(in: .whitespaces).lowercased()
    if ["c", "x", "a", "v"].contains(key ?? "") || ["copy", "cut", "select all", "paste"].contains(named ?? "") {
      throw DeviceError(.secretField, "KOS typed a secret into the field with focus; copying, cutting, selecting or pasting there is refused.")
    }
  }
}

/// A picture's black-outs, in its own pixels.
public enum SecretMask {
  /// Black around a field, in points, so a caret or a border's glow shows nothing either.
  public static let pad = 4.0

  /// Each frame (global points) as a rect of a picture of `source` (global points) drawn at `picture` pixels, top-left
  /// origin, padded, and only what falls inside it.
  public static func pixels(_ frames: [Rect], source: Rect, picture: Size, pad: Double = SecretMask.pad) -> [Rect] {
    guard source.width > 0, source.height > 0 else { return [] }
    let sx = picture.width / source.width
    let sy = picture.height / source.height
    let bounds = Rect(x: 0, y: 0, width: picture.width, height: picture.height)
    return frames.compactMap { f in
      let padded = f.insetBy(-pad)
      let r = Rect(x: (padded.x - source.x) * sx, y: (padded.y - source.y) * sy, width: padded.width * sx, height: padded.height * sy)
      // Out to whole pixels on every side, so a part pixel at an edge is covered too.
      return r.intersection(bounds).map { c in
        let left = c.x.rounded(.down), top = c.y.rounded(.down)
        return Rect(x: left, y: top, width: c.maxX.rounded(.up) - left, height: c.maxY.rounded(.up) - top)
      }
    }
  }
}
