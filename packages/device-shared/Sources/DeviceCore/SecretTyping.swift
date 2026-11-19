import Foundation

// A saved secret typed on this Mac (docs/secrets.md, KOS for Mac): the rules
// keys.secret is held to, the field it goes into as Accessibility describes
// it (never its value), the buffer the value is typed from and zeroed after,
// and what the fields KOS typed into keep from the pictures and the keys
// that follow. Everything here is Foundation alone, behind seams for
// Accessibility and the keyboard, so every rule is tested.

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
  /// True for a field on a web page, its origin known or not.
  public let page: Bool?
  /// The origin of the web page it is in, when every frame around it is on http or https.
  public let origin: String?
  /// The origins of the frames between that page and the field, outermost first, the page's own left out.
  public let frames: [String]?

  public init(
    role: String, secure: Bool, window: String? = nil, label: String? = nil, placeholder: String? = nil, place: FieldPlace = .app
  ) {
    self.role = role
    self.secure = secure
    self.window = window
    self.label = label
    self.placeholder = placeholder
    switch place {
    case .app:
      page = nil
      origin = nil
      frames = nil
    case .page(let top, let inner):
      page = true
      origin = top
      frames = inner.isEmpty ? nil : inner
    case .unknown:
      page = true
      origin = nil
      frames = nil
    }
  }

  /// Where the field is, as it was read.
  public var place: FieldPlace {
    guard page == true else { return .app }
    guard let origin else { return .unknown }
    return .page(origin: origin, frames: frames ?? [])
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
  /// The page's origin, for a field on a page in a browser, and the frames' origins between it and the field.
  public let origin: String?
  public let frames: [String]?

  public init(
    session: String, approved: String, text: String, field: String, app: SecretApp, apps: [String], expect: ExpectedField,
    origin: String? = nil, frames: [String]? = nil
  ) {
    self.session = session
    self.approved = approved
    self.text = text
    self.field = field
    self.app = app
    self.apps = apps
    self.expect = expect
    self.origin = origin
    self.frames = frames
  }

  /// Where the owner approved the field to be.
  var place: FieldPlace {
    origin.map { .page(origin: $0, frames: frames ?? []) } ?? .app
  }
}

/// keys.secret's answer: that it was typed, and whether the field's length grew by as much. No field, no echo.
public struct SecretTypedResult: Encodable, Equatable, Sendable {
  public let typed = true
  /// False when the field's character count (AXNumberOfCharacters, never its value) did not grow by what was typed:
  /// keys were lost or the app changed what went in. Absent when the field would not say.
  public let landed: Bool?

  public init(landed: Bool? = nil) {
    self.landed = landed
  }
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

  /// The chunks it is typed in: at most `size` units each, but never splitting a character's surrogate pair, which
  /// goes as one chunk of two when `size` is one.
  func chunks(of size: Int) -> [Range<Int>] {
    var ranges: [Range<Int>] = []
    var start = 0
    while start < units.count {
      var end = min(start + size, units.count)
      if end < units.count, UTF16.isLeadSurrogate(units[end - 1]) { end += end - start > 1 ? -1 : 1 }
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
/// Mac itself (one of its windows has the keyboard, or its menu is open), whether it is on the hidden list, and the
/// session's window for a session given one window alone.
public struct SecretScene: Sendable {
  public let front: FrontApp?
  public let pid: Int32?
  public let own: Bool
  public let hidden: Bool
  /// The frame of the one window the session was given (global points, top-left); nil for the whole screen.
  public let window: Rect?

  public init(front: FrontApp?, pid: Int32?, own: Bool, hidden: Bool, window: Rect? = nil) {
    self.front = front
    self.pid = pid
    self.own = own
    self.hidden = hidden
    self.window = window
  }
}

/// The keyboard a secret is typed on, behind a seam so the typing is tested.
@MainActor
public protocol SecretKeyboard: AnyObject {
  /// Whether this app may post key events (CGPreflightPostEventAccess), asked without prompting the owner.
  var canPost: Bool { get }
  /// One chunk, as one key event carrying it, posted to the app with this pid alone.
  func post(_ units: UnsafeBufferPointer<UInt16>, to pid: Int32) throws
  /// After each chunk: the owner's hand or Stop halts it, and the chunks are paced as typing is.
  func between() async throws
}

/// A field KOS typed a secret into, kept for the session: the app it is in, and the web page around it as it was then,
/// so a page that hides the field without moving on is still blacked out.
struct TypedField<Element> {
  let element: Element
  let pid: Int32
  let page: Element?
  let address: String?
}

/// The rules keys.secret is held to, the field it goes into read through Accessibility, and the fields typed into.
///
/// Before typing: the session is live and the one approved; KOS for Mac's own
/// window does not have the keyboard; the app in front is the one approved,
/// one the secret allows and not hidden; the field in focus is a text field
/// (never a search field), the one approved (its role, whether it is a
/// password field, its window, the session's window for a one-window
/// session), of the kind the secret goes into (a password only into a
/// password field; a card's number or code only where the field's label or
/// hint says so), and on the page and frames approved, every one on http or
/// https. Then it is typed as unicode a character at a time, posted to that
/// app alone, from a buffer zeroed after, every check made again just before
/// each character: a field typed part of the way is said (`partial`), never
/// passed off as typed. The field is kept: a picture blacks it out, and
/// copying out of it or typing into it again is refused for the session.
@MainActor
public final class SecretDesk<Access: FieldAccess> {
  private let access: Access
  /// The fields typed into, for the session they were typed in.
  private var typed: [TypedField<Access.Element>] = []
  private var session: String?

  /// Things that answer to these roles are typed into; a search field never is.
  static var typeable: Set<String> { ["AXTextField", "AXTextArea", "AXComboBox"] }
  static var secureRole: String { "AXSecureTextField" }
  static var searchRole: String { "AXSearchField" }
  /// Units posted in one key event: one character, so a focus change is caught before the next.
  static var chunk: Int { 1 }
  /// How far a field's window may be from the session's window, in points, and still be it.
  static var windowSlack: Double { 2 }
  /// How far up from what is under a point a menu item is looked for.
  static var menuDepth: Int { 6 }
  /// The menu items that may be clicked while a field KOS typed a secret into has focus, by their Command key: close,
  /// new tab, new window, reload, open location, back and forward. None copies, pastes, selects, shares or looks up.
  static var menuAllowed: Set<String> { ["w", "t", "n", "r", "l", "[", "]"] }

  public init(_ access: Access) {
    self.access = access
  }

  /// The fields typed into this session, for whoever else reads from the screen (the chat's selection reader).
  public var typedFields: [Access.Element] { typed.map(\.element) }

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
      placeholder: placeholder?.isEmpty == false ? placeholder : nil, place: PagePlace.walk(element, access).place)
  }

  static func originOf(_ address: String) -> String? {
    PagePlace.originOf(address)
  }

  // MARK: Typing

  /// Every check, then the value (`buffer`, read from the params' text) typed on `keys` a character at a time, each
  /// posted to the approved app alone, the field kept. The checks run again just before every character and after
  /// the last, on the scene as it is then, and the field in focus must still be the very one first checked. A
  /// failure before anything went in is that refusal; after, it is `partial`, naming how much went in, and whatever
  /// now has focus is kept with the field. The buffer is zeroed whatever happens. A refusal never names the value.
  public func type(
    _ params: SecretTypeParams, buffer: SecretBuffer, live: String, scene: () -> SecretScene, keys: SecretKeyboard
  ) async throws -> SecretTypedResult {
    defer { buffer.wipe() }
    guard keys.canPost else {
      throw DeviceError(.permission, "KOS for Mac may not post keystrokes on this Mac: allow it under Accessibility in System Settings.")
    }
    let (field, pid) = try check(params, buffer: buffer, live: live, scene: scene())
    let total = buffer.count
    let before = access.number("AXNumberOfCharacters", of: field)
    let replaced = access.selectedLength(of: field)
    var sent = 0
    defer {
      if sent > 0 { note(field, pid: pid, session: live) }
    }
    /// The checks again, and the field the very one: else, once any went in, how much did.
    func still() throws {
      do {
        guard try check(params, buffer: buffer, live: live, scene: scene()).element == field else {
          throw DeviceError(.field, "Focus moved to another field.")
        }
      } catch let error as DeviceError {
        throw partial(error, sent: sent, of: total, into: field, pid: pid, session: live)
      }
    }
    for range in buffer.chunks(of: Self.chunk) {
      try still()
      do {
        try buffer.with(range) { try keys.post($0, to: pid) }
        sent += range.count
        try await keys.between()
      } catch let error as DeviceError {
        throw partial(error, sent: sent, of: total, into: field, pid: pid, session: live)
      }
    }
    try still()
    let after = access.number("AXNumberOfCharacters", of: field)
    guard let before, let after, replaced != nil || before == 0 else { return SecretTypedResult() }
    return SecretTypedResult(landed: after == before - (replaced ?? 0) + total)
  }

  /// A typing stopped after `sent` of `total` units went in: whatever has focus in the app now is kept with the
  /// field, since some of it may have gone there, and the refusal says how far it got.
  private func partial(_ error: DeviceError, sent: Int, of total: Int, into field: Access.Element, pid: Int32, session: String) -> DeviceError {
    guard sent > 0 else { return error }
    note(field, pid: pid, session: session)
    if let now = access.focused(pid: pid) { note(now, pid: pid, session: session) }
    return DeviceError(
      .partial,
      "Typed \(sent) of \(total) characters, then stopped: \(error.message) The field holds part of the secret; the owner should clear it.")
  }

  private func check(
    _ p: SecretTypeParams, buffer: SecretBuffer, live: String, scene: SecretScene
  ) throws -> (element: Access.Element, pid: Int32) {
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
    if let window = scene.window, !inWindow(element, window) {
      throw DeviceError(.field, "The field with focus is not in the window the session was given.")
    }
    if let refusal = Self.refusal(of: p.field, into: field) { throw DeviceError(.field, refusal) }
    switch (field.place, p.place) {
    case (.unknown, _):
      throw DeviceError(.origin, "The field is on a page whose address KOS cannot read, or is not http or https; no secret goes there.")
    case (let here, let approved) where here != approved:
      throw DeviceError(.origin, here == .app || approved == .app
        ? "The field is not on the page the owner approved." : "The page in front is not on the site and frames the owner approved.")
    default:
      break
    }
    return (element, pid)
  }

  /// Whether the element's window is the session's one window, by where it is: titles change and repeat.
  private func inWindow(_ element: Access.Element, _ window: Rect) -> Bool {
    guard let frame = access.element("AXWindow", of: element).flatMap(access.frame) else { return false }
    let slack = Self.windowSlack
    return abs(frame.x - window.x) <= slack && abs(frame.y - window.y) <= slack
      && abs(frame.width - window.width) <= slack && abs(frame.height - window.height) <= slack
  }

  /// Why a secret's field may not go into this one, if it may not: a password only into a password field, a card's
  /// number and code only where the field's own words say so. A field with no words takes neither.
  static func refusal(of kind: String, into field: FieldIdentity) -> String? {
    let words = [field.label, field.placeholder].compactMap { $0?.lowercased() }.joined(separator: " ")
    switch kind {
    case "password":
      return field.secure ? nil : "A password goes only into a password field, and this one shows what is typed."
    case "card-number":
      return words.range(of: #"card|number|credit|debit|\bcc\b|\bpan\b"#, options: .regularExpression) != nil
        ? nil : "The field does not say it takes a card number."
    case "card-cvc":
      return words.range(of: #"cvc|cvv|csc|cid|security"#, options: .regularExpression) != nil
        ? nil : "The field does not say it takes a card's security code."
    default:
      return nil
    }
  }

  // MARK: The fields typed into

  private func note(_ element: Access.Element, pid: Int32, session: String) {
    if self.session != session {
      typed = []
      self.session = session
    }
    guard !typed.contains(where: { $0.element == element }) else { return }
    let walk = PagePlace.walk(element, access)
    typed.append(TypedField(element: element, pid: pid, page: walk.top, address: walk.address))
  }

  /// The session ended: what it typed into is no longer kept.
  public func end() {
    typed = []
    session = nil
  }

  /// Whether the field in focus in this app is one KOS typed a secret into this session.
  public func typedHasFocus(pid: Int32?) -> Bool {
    focusedTyped(pid: pid) != nil
  }

  private func focusedTyped(pid: Int32?) -> Access.Element? {
    guard let pid, !typed.isEmpty, let focused = access.focused(pid: pid) else { return nil }
    return typed.contains { $0.element == focused } ? focused : nil
  }

  /// What a picture blacks out, in global points: every field typed into that can be found, and a password field in
  /// focus. A field typed into that is gone while the page it was on is still in front at the same address (hidden by
  /// the page, not left behind) blacks out that whole page until it moves on. Refused (secret_field) while a typed
  /// field or a password field is in focus and cannot be found.
  public func masks(pid: Int32?) throws -> [Rect] {
    let focused = pid.flatMap { access.focused(pid: $0) }
    var rects: [Rect] = []
    for field in typed {
      if let frame = access.frame(of: field.element) {
        rects.append(frame)
      } else if field.element == focused {
        throw DeviceError(.secretField, "A field KOS typed a secret into has focus and cannot be found, so no picture is taken.")
      } else if field.pid == pid, let page = field.page, let frame = access.frame(of: page),
                PagePlace.address(of: page, access) == field.address {
        rects.append(frame)
      }
    }
    if let focused, !typed.contains(where: { $0.element == focused }), identity(of: focused)?.secure == true {
      guard let frame = access.frame(of: focused) else {
        throw DeviceError(.secretField, "A password field has focus and cannot be found, so no picture is taken.")
      }
      rects.append(frame)
    }
    return rects
  }

  // MARK: Keys and the pointer, while a field typed into has focus

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

  /// A click while a field KOS typed a secret into has focus: within the field, one plain left click alone (a double
  /// or triple click selects, a right or middle click opens a menu, a modifier extends); anywhere, never a menu item
  /// but the few in `menuAllowed`.
  public func refuseClick(at point: Point, button: MouseButton, count: Int, modifiers: Modifiers, pid: Int32?) throws {
    guard let field = focusedTyped(pid: pid) else { return }
    if inField(point, field), count > 1 || button != .left || !modifiers.isEmpty {
      throw DeviceError(.secretField, "KOS typed a secret into this field; only a plain click goes there, never one that selects, extends or opens a menu.")
    }
    try refuseMenuItem(at: point)
  }

  /// A drag while a field KOS typed a secret into has focus, refused when it starts in that field: it would select
  /// or carry its text away.
  public func refuseDrag(from point: Point, pid: Int32?) throws {
    guard let field = focusedTyped(pid: pid), inField(point, field) else { return }
    throw DeviceError(.secretField, "KOS typed a secret into this field; nothing is dragged out of it.")
  }

  /// Whether a point is in the field, padded as a picture's mask is; a field that cannot be found counts as anywhere.
  private func inField(_ point: Point, _ field: Access.Element) -> Bool {
    guard let frame = access.frame(of: field) else { return true }
    return frame.insetBy(-SecretMask.pad).contains(point)
  }

  /// A menu item under the point, refused unless its Command key (Command alone) is one of `menuAllowed`: Copy,
  /// Services, Share, Look Up, Speak, a search for the selection and anything else that could carry it out is not.
  private func refuseMenuItem(at point: Point) throws {
    var at = access.element(at: point)
    for _ in 0..<Self.menuDepth {
      guard let e = at else { return }
      if access.string("AXRole", of: e) == "AXMenuItem" {
        let key = access.string("AXMenuItemCmdChar", of: e)?.lowercased() ?? ""
        let commandOnly = (access.number("AXMenuItemCmdModifiers", of: e) ?? 0) == 0
        if Self.menuAllowed.contains(key), commandOnly { return }
        throw DeviceError(.secretField, "KOS typed a secret into the field with focus; only a menu's Close, New Tab, New Window, Reload, Open Location, Back and Forward are clicked meanwhile.")
      }
      at = access.element("AXParent", of: e)
    }
  }

  // MARK: KOS's own pages

  /// Why an action may not land where it would, if it may not: on KOS's own dashboard or a browser extension's
  /// page, KOS for Chrome's panel among them, where an approval can be decided. The pointer's target is what is under
  /// it; the keys', what has focus in the app in front.
  public func refuseOwnPage(at point: Point, dashboards: [String]) throws {
    guard let element = access.element(at: point), let refusal = PagePlace.ownPage(of: element, access, dashboards: dashboards) else { return }
    throw DeviceError(.target, refusal)
  }

  public func refuseOwnPage(focusedIn pid: Int32?, dashboards: [String]) throws {
    guard let pid, let element = access.focused(pid: pid),
          let refusal = PagePlace.ownPage(of: element, access, dashboards: dashboards) else { return }
    throw DeviceError(.target, refusal)
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
