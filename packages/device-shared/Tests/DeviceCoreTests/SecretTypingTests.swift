import Foundation
import Testing

@testable import DeviceCore

/// A saved secret typed on the Mac: refused into the wrong app, the wrong field or the wrong page, typed a character
/// at a time to the approved app from a buffer zeroed after, answered with an outcome alone, and the field kept out of
/// pictures, copies and menus.
@Suite("A secret typed")
@MainActor
struct SecretTypingTests {
  /// An app's Accessibility tree, by element id, and which element has focus in each app. Every attribute asked is
  /// written down, so a test can say the field's value is never read.
  final class Fake: FieldAccess {
    var attributes: [Int: [String: Any]] = [:]
    var frames: [Int: Rect] = [:]
    var focus: [Int32: Int] = [:]
    /// What is under each point, by its rect.
    var under: [(Rect, Int)] = []
    private(set) var asked: [String] = []

    func focused(pid: Int32) -> Int? { focus[pid] }
    func element(at point: Point) -> Int? { under.first { $0.0.contains(point) }?.1 }
    func string(_ attribute: String, of element: Int) -> String? {
      asked.append(attribute)
      return attributes[element]?[attribute] as? String
    }
    func element(_ attribute: String, of element: Int) -> Int? {
      asked.append(attribute)
      return attributes[element]?[attribute] as? Int
    }
    func url(_ attribute: String, of element: Int) -> String? {
      asked.append(attribute)
      return attributes[element]?[attribute] as? String
    }
    func number(_ attribute: String, of element: Int) -> Int? {
      asked.append(attribute)
      return attributes[element]?[attribute] as? Int
    }
    func selectedLength(of element: Int) -> Int? { attributes[element]?["selected"] as? Int }
    func frame(of element: Int) -> Rect? { frames[element] }
  }

  nonisolated static let canary = "pw-Canary-\u{1F511}-91zq-long-enough"
  nonisolated static let safari = FrontApp(name: "Safari", bundle: "com.apple.Safari")
  nonisolated static let pid: Int32 = 42
  nonisolated static let windowFrame = Rect(x: 0, y: 0, width: 1200, height: 800)

  /// Safari with a sign-in page: a password field (1), a text field (2) and a search field (3), in window 9, on a
  /// web area (8) at github.com.
  static func page() -> Fake {
    let fake = Fake()
    fake.attributes = [
      1: ["AXRole": "AXTextField", "AXSubrole": "AXSecureTextField", "AXWindow": 9, "AXParent": 8, "AXDescription": "Password", "AXValue": canary],
      2: ["AXRole": "AXTextField", "AXWindow": 9, "AXParent": 8, "AXPlaceholderValue": "Username or email"],
      3: ["AXRole": "AXTextField", "AXSubrole": "AXSearchField", "AXWindow": 9, "AXParent": 8],
      8: ["AXRole": "AXWebArea", "AXURL": "https://github.com/login?return_to=x", "AXParent": 9],
      9: ["AXRole": "AXWindow", "AXTitle": "Sign in to GitHub"],
    ]
    fake.frames = [1: Rect(x: 100, y: 200, width: 300, height: 30), 2: Rect(x: 100, y: 150, width: 300, height: 30), 8: Rect(x: 0, y: 80, width: 1200, height: 720), 9: windowFrame]
    fake.focus = [pid: 1]
    return fake
  }

  static func params(
    field: String = "password", bundle: String = "com.apple.Safari", apps: [String] = ["com.apple.Safari"], secure: Bool = true,
    window: String? = "Sign in to GitHub", origin: String? = "https://github.com", frames: [String]? = nil, approved: String = "s1",
    text: String = canary
  ) -> SecretTypeParams {
    SecretTypeParams(
      session: "s1", approved: approved, text: text, field: field, app: SecretApp(bundle: bundle), apps: apps,
      expect: ExpectedField(role: "AXTextField", secure: secure, window: window), origin: origin, frames: frames)
  }

  /// What was posted, chunk by chunk, and to which app; `onPost` runs after each.
  final class Keys: SecretKeyboard {
    var chunks: [[UInt16]] = []
    var pids: [Int32] = []
    var failAt: Int?
    var canPost = true
    var onPost: () -> Void = {}
    var typed: String { String(decoding: chunks.flatMap { $0 }, as: UTF16.self) }

    func post(_ units: UnsafeBufferPointer<UInt16>, to pid: Int32) throws {
      if chunks.count == failAt { throw DeviceError(.internal, "the key event could not be made") }
      chunks.append(Array(units))
      pids.append(pid)
      onPost()
    }

    func between() async throws {}
  }

  nonisolated static func scene(_ front: FrontApp? = safari, own: Bool = false, hidden: Bool = false, window: Rect? = nil) -> SecretScene {
    SecretScene(front: front, pid: front == nil ? nil : pid, own: own, hidden: hidden, window: window)
  }

  /// keys.secret with these params into the fake, as the controller calls it.
  @discardableResult
  static func type(
    _ desk: SecretDesk<Fake>, _ p: SecretTypeParams, keys: Keys? = nil, buffer: SecretBuffer? = nil, scene: (() -> SecretScene)? = nil
  ) async throws -> SecretTypedResult {
    try await desk.type(p, buffer: buffer ?? SecretBuffer(p.text), live: "s1", scene: scene ?? { Self.scene() }, keys: keys ?? Keys())
  }

  static func refusal(_ desk: SecretDesk<Fake>, _ p: SecretTypeParams, keys: Keys? = nil, scene: (() -> SecretScene)? = nil) async -> DeviceError? {
    do {
      try await type(desk, p, keys: keys, scene: scene)
      return nil
    } catch let error as DeviceError {
      return error
    } catch {
      return DeviceError(.internal, "\(error)")
    }
  }

  // MARK: Typing

  @Test func typesTheValueACharacterAtATimeToTheApprovedApp() async throws {
    let keys = Keys()
    let desk = SecretDesk(Self.page())
    let result = try await Self.type(desk, Self.params(), keys: keys)
    #expect(result == SecretTypedResult())
    #expect(keys.typed == Self.canary)
    #expect(keys.pids.allSatisfy { $0 == Self.pid })
    // One unit an event, the key's surrogate pair alone going as two.
    #expect(keys.chunks.allSatisfy { $0.count == 1 || ($0.count == 2 && UTF16.isLeadSurrogate($0[0])) })
    #expect(keys.chunks.contains { $0.count == 2 })
  }

  @Test func refusesWithoutLeaveToPostKeys() async {
    let keys = Keys()
    keys.canPost = false
    #expect(await Self.refusal(SecretDesk(Self.page()), Self.params(), keys: keys)?.code == .permission)
    #expect(keys.chunks.isEmpty)
  }

  @Test func refusesAnotherAppThanTheOneApprovedOrAllowed() async {
    let desk = SecretDesk(Self.page())
    let chrome = FrontApp(name: "Google Chrome", bundle: "com.google.Chrome")
    #expect(await Self.refusal(desk, Self.params(), scene: { Self.scene(chrome) })?.code == .target)
    #expect(await Self.refusal(desk, Self.params(apps: ["com.google.Chrome"]))?.code == .target)
    #expect(await Self.refusal(desk, Self.params(), scene: { Self.scene(nil) })?.code == .target)
    #expect(await Self.refusal(desk, Self.params(), scene: { Self.scene(own: true) })?.code == .target)
    #expect(await Self.refusal(desk, Self.params(), scene: { Self.scene(hidden: true) })?.code == .hiddenApp)
  }

  @Test func refusesAPasswordIntoAFieldThatShowsIt() async {
    let fake = Self.page()
    fake.focus = [Self.pid: 2]
    let desk = SecretDesk(fake)
    // Approved as that very field, a password still does not go into it.
    #expect(await Self.refusal(desk, Self.params(secure: false))?.code == .field)
    // A username does.
    #expect(await Self.refusal(desk, Self.params(field: "username", secure: false)) == nil)
    // A search field takes nothing, nor does no field at all.
    fake.focus = [Self.pid: 3]
    #expect(await Self.refusal(desk, Self.params(field: "username", secure: false))?.code == .field)
    fake.focus = [:]
    #expect(await Self.refusal(desk, Self.params())?.code == .field)
  }

  @Test func refusesAFieldOtherThanTheOneApprovedOrAnotherSession() async {
    let desk = SecretDesk(Self.page())
    #expect(await Self.refusal(desk, Self.params(window: "Another window"))?.code == .field)
    #expect(await Self.refusal(desk, Self.params(secure: false))?.code == .field)
    #expect(await Self.refusal(desk, Self.params(approved: "s0"))?.code == .noSession)
  }

  /// A session given one window types only into a field in that window, known by where it is, never by its title.
  @Test func aOneWindowSessionTypesOnlyIntoItsWindow() async {
    let desk = SecretDesk(Self.page())
    #expect(await Self.refusal(desk, Self.params(), scene: { Self.scene(window: Self.windowFrame) }) == nil)
    let another = Rect(x: 1300, y: 0, width: 800, height: 600)
    #expect(await Self.refusal(desk, Self.params(), scene: { Self.scene(window: another) })?.code == .field)
  }

  // MARK: The page

  @Test func refusesAPageOnAnotherSiteThanTheOneApproved() async {
    let desk = SecretDesk(Self.page())
    #expect(await Self.refusal(desk, Self.params(origin: "https://github.com.evil.example"))?.code == .origin)
    // A field on a page is never typed into as though it were an app's own.
    #expect(await Self.refusal(desk, Self.params(origin: nil))?.code == .origin)
  }

  /// A page whose address is not read, or not http or https, takes no secret, whatever was approved.
  @Test func refusesAPageWhoseOriginIsUnknown() async {
    for address: String? in [nil, "file:///Users/me/login.html", "chrome-extension://abc/panel.html", "about:blank"] {
      let fake = Self.page()
      fake.attributes[8]?["AXURL"] = address
      let desk = SecretDesk(fake)
      #expect(desk.describe(pid: Self.pid, bundle: Self.safari.bundle)?.place == .unknown, "\(address ?? "none")")
      #expect(await Self.refusal(desk, Self.params(origin: nil))?.code == .origin, "\(address ?? "none")")
      #expect(await Self.refusal(desk, Self.params())?.code == .origin, "\(address ?? "none")")
    }
  }

  @Test func readsTheAddressFromAXDocumentWhenThereIsNoAXURL() {
    let fake = Self.page()
    fake.attributes[8]?["AXURL"] = nil
    fake.attributes[8]?["AXDocument"] = "https://github.com/session"
    #expect(SecretDesk(fake).describe(pid: Self.pid, bundle: Self.safari.bundle)?.place == .page(origin: "https://github.com", frames: []))
  }

  /// Every frame is read up to the top page: its origin is the page's, the others are named for the approval.
  @Test func namesEveryFrameBetweenThePageAndTheField() async {
    let fake = Self.page()
    fake.attributes[1]?["AXParent"] = 20
    fake.attributes[20] = ["AXRole": "AXWebArea", "AXURL": "https://js.stripe.com/v3/frame", "AXParent": 21]
    fake.attributes[21] = ["AXRole": "AXGroup", "AXParent": 22]
    fake.attributes[22] = ["AXRole": "AXWebArea", "AXURL": "https://github.com/inner", "AXParent": 8]
    let desk = SecretDesk(fake)
    #expect(desk.describe(pid: Self.pid, bundle: Self.safari.bundle)?.place == .page(origin: "https://github.com", frames: ["https://js.stripe.com"]))
    #expect(await Self.refusal(desk, Self.params())?.code == .origin)
    #expect(await Self.refusal(desk, Self.params(frames: ["https://js.stripe.com"])) == nil)
    // A frame on a page that is not http or https makes the whole place unknown.
    fake.attributes[20]?["AXURL"] = "blob:https://evil.example/1"
    #expect(desk.describe(pid: Self.pid, bundle: Self.safari.bundle)?.place == .unknown)
  }

  /// A field whose window is not found within the walk is on a page KOS cannot vouch for.
  @Test func refusesWhenTheWalkUpRunsOut() async {
    let fake = Self.page()
    for n in 100..<200 { fake.attributes[n] = ["AXRole": "AXGroup", "AXParent": n + 1] }
    fake.attributes[1]?["AXParent"] = 100
    let desk = SecretDesk(fake)
    #expect(desk.describe(pid: Self.pid, bundle: Self.safari.bundle)?.place == .unknown)
    #expect(await Self.refusal(desk, Self.params(origin: nil))?.code == .origin)
  }

  @Test func takesACardNumberOnlyWhereTheFieldSaysSo() {
    let named = FieldIdentity(role: "AXTextField", secure: false, label: "Card number")
    let other = FieldIdentity(role: "AXTextField", secure: false, label: "Search orders")
    let unnamed = FieldIdentity(role: "AXTextField", secure: false)
    #expect(SecretDesk<Fake>.refusal(of: "card-number", into: named) == nil)
    #expect(SecretDesk<Fake>.refusal(of: "card-number", into: other) != nil)
    #expect(SecretDesk<Fake>.refusal(of: "card-number", into: unnamed) != nil)
    #expect(SecretDesk<Fake>.refusal(of: "card-cvc", into: FieldIdentity(role: "AXTextField", secure: false, placeholder: "CVV")) == nil)
    #expect(SecretDesk<Fake>.refusal(of: "card-cvc", into: other) != nil)
    #expect(SecretDesk<Fake>.refusal(of: "card-cvc", into: unnamed) != nil)
    #expect(SecretDesk<Fake>.refusal(of: "username", into: unnamed) == nil)
  }

  // MARK: Part of the way

  @Test func zeroesTheBufferWhetherItTypedRefusedOrFailed() async throws {
    let desk = SecretDesk(Self.page())
    let typed = SecretBuffer(Self.canary)
    try await Self.type(desk, Self.params(), buffer: typed)
    #expect(typed.isWiped && typed.count == Self.canary.utf16.count)
    let refused = SecretBuffer(Self.canary)
    await #expect(throws: DeviceError.self) { try await Self.type(desk, Self.params(apps: []), buffer: refused) }
    #expect(refused.isWiped)
    let keys = Keys()
    keys.failAt = 1
    let failed = SecretBuffer(Self.canary)
    await #expect(throws: DeviceError.self) { try await Self.type(desk, Self.params(), keys: keys, buffer: failed) }
    #expect(failed.isWiped)
  }

  /// Focus moving after some characters went in stops at the next one, says how many went in (`partial`), and keeps
  /// the field that now has focus with the one approved.
  @Test func stopsAtTheNextCharacterAfterFocusMovesAndSaysHowFarItGot() async throws {
    let fake = Self.page()
    let desk = SecretDesk(fake)
    let keys = Keys()
    let buffer = SecretBuffer(Self.canary)
    keys.onPost = { if keys.chunks.count == 3 { fake.focus = [Self.pid: 2] } }
    let error = await Self.refusalWith(desk, Self.params(), keys: keys, buffer: buffer)
    #expect(error?.code == .partial)
    #expect(error?.message.hasPrefix("Typed 3 of \(Self.canary.utf16.count) characters") == true)
    #expect(error.map { !$0.message.contains("91zq") } == true)
    #expect(keys.chunks.count == 3 && buffer.isWiped)
    // Both fields are kept: blacked out and guarded.
    #expect(try desk.masks(pid: Self.pid).rects == [Rect(x: 100, y: 200, width: 300, height: 30), Rect(x: 100, y: 150, width: 300, height: 30)])
    #expect(desk.typedHasFocus(pid: Self.pid))
    // Another app coming to the front, or KOS for Mac's own menu opening, stops it too, after the same count.
    var front = Self.safari
    var own = false
    let changes: [() -> Void] = [{ front = FrontApp(name: "Notes", bundle: "com.apple.Notes") }, { own = true }]
    for change in changes {
      fake.focus = [Self.pid: 1]
      front = Self.safari
      own = false
      let more = Keys()
      more.onPost = { if more.chunks.count == 1 { change() } }
      let stopped = await Self.refusal(desk, Self.params(), keys: more, scene: { Self.scene(front, own: own) })
      #expect(stopped?.code == .partial)
      #expect(more.chunks.count == 1)
    }
  }

  static func refusalWith(_ desk: SecretDesk<Fake>, _ p: SecretTypeParams, keys: Keys, buffer: SecretBuffer) async -> DeviceError? {
    do {
      try await type(desk, p, keys: keys, buffer: buffer)
      return nil
    } catch {
      return error as? DeviceError
    }
  }

  /// Nothing typed yet is a plain refusal, never `partial`.
  @Test func aRefusalBeforeAnyCharacterIsNotPartial() async {
    let keys = Keys()
    keys.failAt = 0
    #expect(await Self.refusal(SecretDesk(Self.page()), Self.params(), keys: keys)?.code == .internal)
  }

  /// The field's length, never its value, says whether every key landed.
  @Test func saysWhetherTheFieldGrewByWhatWasTyped() async throws {
    let fake = Self.page()
    fake.attributes[1]?["AXNumberOfCharacters"] = 0
    let keys = Keys()
    keys.onPost = { fake.attributes[1]?["AXNumberOfCharacters"] = keys.chunks.flatMap { $0 }.count }
    #expect(try await Self.type(SecretDesk(fake), Self.params(), keys: keys).landed == true)
    // Two keys lost.
    fake.attributes[1]?["AXNumberOfCharacters"] = 0
    let lossy = Keys()
    lossy.onPost = { fake.attributes[1]?["AXNumberOfCharacters"] = max(0, lossy.chunks.flatMap { $0 }.count - 2) }
    #expect(try await Self.type(SecretDesk(fake), Self.params(), keys: lossy).landed == false)
    // Typed over a selection of four in a field of ten.
    fake.attributes[1]?["AXNumberOfCharacters"] = 10
    fake.attributes[1]?["selected"] = 4
    let over = Keys()
    over.onPost = { fake.attributes[1]?["AXNumberOfCharacters"] = 6 + over.chunks.flatMap { $0 }.count }
    #expect(try await Self.type(SecretDesk(fake), Self.params(), keys: over).landed == true)
    // A field that will not say its length, or its selection when it is not empty, says nothing.
    fake.attributes[1]?["selected"] = nil
    #expect(try await Self.type(SecretDesk(fake), Self.params()).landed == nil)
    fake.attributes[1]?["AXNumberOfCharacters"] = nil
    #expect(try await Self.type(SecretDesk(fake), Self.params()).landed == nil)
  }

  @Test func answersAnOutcomeAloneAndNeverTheValue() async throws {
    let body = try JSONSerialization.jsonObject(with: Outbound.reply(id: 3, result: SecretTypedResult())) as? [String: Any]
    #expect(body?["result"] as? [String: Bool] == ["typed": true])
    let landed = try JSONSerialization.jsonObject(with: Outbound.reply(id: 3, result: SecretTypedResult(landed: false))) as? [String: Any]
    #expect(landed?["result"] as? [String: Bool] == ["typed": true, "landed": false])
    // Every refusal says what is wrong and nothing of what was to be typed.
    let fake = Self.page()
    let desk = SecretDesk(fake)
    var refusals: [DeviceError] = []
    for p in [Self.params(apps: []), Self.params(window: "x"), Self.params(origin: nil), Self.params(approved: "s0"), Self.params(text: "\(Self.canary)\n")] {
      if let e = await Self.refusal(desk, p) { refusals.append(e) }
    }
    fake.focus = [Self.pid: 2]
    if let e = await Self.refusal(desk, Self.params(secure: false)) { refusals.append(e) }
    #expect(refusals.count == 6)
    for e in refusals {
      #expect(!e.message.contains(Self.canary) && !e.message.contains("91zq"))
      #expect(try !String(decoding: Outbound.reply(id: 1, error: e), as: UTF8.self).contains("91zq"))
    }
    // The field's value is never asked for.
    #expect(!fake.asked.contains("AXValue"))
  }

  @Test func refusesASecretThatWouldActRatherThanType() async {
    let desk = SecretDesk(Self.page())
    #expect(await Self.refusal(desk, Self.params(text: "two\tparts"))?.code == .badRequest)
    #expect(await Self.refusal(desk, Self.params(text: ""))?.code == .badRequest)
  }

  // MARK: Pictures

  @Test func blacksOutTheFieldsTypedIntoAndAFocusedPasswordField() async throws {
    let fake = Self.page()
    let desk = SecretDesk(fake)
    // Nothing typed yet: the password field in focus is blacked out all the same.
    #expect(try desk.masks(pid: Self.pid).rects == [Rect(x: 100, y: 200, width: 300, height: 30)])
    fake.focus = [Self.pid: 2]
    #expect(try desk.masks(pid: Self.pid).rects.isEmpty)
    try await Self.type(desk, Self.params(field: "username", secure: false))
    fake.focus = [Self.pid: 1]
    try await Self.type(desk, Self.params())
    #expect(try desk.masks(pid: Self.pid).rects == [Rect(x: 100, y: 150, width: 300, height: 30), Rect(x: 100, y: 200, width: 300, height: 30)])
    // One in focus that cannot be found refuses the picture.
    fake.frames[2] = nil
    fake.focus = [Self.pid: 2]
    #expect(throws: DeviceError(.secretField, "A field KOS typed a secret into has focus and cannot be found, so no picture is taken.")) { try desk.masks(pid: Self.pid) }
    // So does a password field in focus that cannot be found, typed into or not.
    desk.end()
    fake.focus = [Self.pid: 1]
    fake.frames[1] = nil
    #expect(throws: DeviceError.self) { try desk.masks(pid: Self.pid) }
  }

  /// A field typed into that the page hid, with the page still in front at the same address, blacks out the whole
  /// page; once the page has moved on, or another app is in front, it is let be.
  @Test func aFieldThePageHidBlacksOutThePageUntilItMovesOn() async throws {
    let fake = Self.page()
    let desk = SecretDesk(fake)
    try await Self.type(desk, Self.params())
    fake.frames[1] = nil
    fake.focus = [Self.pid: 2]
    let page = Rect(x: 0, y: 80, width: 1200, height: 720)
    #expect(try desk.masks(pid: Self.pid) == SecretMasks(rects: [page], pageMasked: true))
    #expect(try desk.masks(pid: 7).rects.isEmpty)
    fake.attributes[8]?["AXURL"] = "https://github.com/"
    #expect(try desk.masks(pid: Self.pid).rects.isEmpty)
    fake.attributes[8]?["AXURL"] = "https://github.com/login?return_to=x"
    fake.frames[8] = nil
    #expect(try desk.masks(pid: Self.pid).rects.isEmpty)
  }

  @Test func placesTheBlackOutsInThePicturesPixels() {
    // A 1512x982 screen drawn at 1232x800: the field, padded, scaled and kept inside the picture.
    let source = Rect(x: 0, y: 0, width: 1512, height: 982)
    let picture = Size(width: 1232, height: 800)
    let field = Rect(x: 100, y: 200, width: 300, height: 30)
    let scale = 1232.0 / 1512.0
    let got = SecretMask.pixels([field], source: source, picture: picture)
    #expect(got.count == 1)
    let r = got[0]
    #expect(r.x <= (100 - SecretMask.pad) * scale && r.maxX >= (400 + SecretMask.pad) * scale)
    #expect(r.y <= (200 - SecretMask.pad) * (800 / 982.0) && r.maxY >= (230 + SecretMask.pad) * (800 / 982.0))
    // A region of the screen: the same field in that region's own pixels; one outside it is not drawn.
    let region = Rect(x: 80, y: 180, width: 400, height: 100)
    #expect(SecretMask.pixels([field], source: region, picture: Size(width: 800, height: 200)) == [Rect(x: 32, y: 32, width: 616, height: 76)])
    #expect(SecretMask.pixels([Rect(x: 900, y: 900, width: 10, height: 10)], source: region, picture: Size(width: 800, height: 200)).isEmpty)
    // A field running off the edge is cut at it.
    #expect(SecretMask.pixels([Rect(x: 470, y: 190, width: 100, height: 20)], source: region, picture: Size(width: 400, height: 100)) == [Rect(x: 386, y: 6, width: 14, height: 28)])
  }

  // MARK: Keys, clicks, drags and menus

  @Test func refusesCopyingOutOfOrTypingIntoAFieldTypedInto() async throws {
    let fake = Self.page()
    let desk = SecretDesk(fake)
    // Before anything is typed, the keys are not this desk's to judge.
    #expect(try desk.allowsPress(KeyCombo.parse("cmd+c"), pid: Self.pid) == false)
    try desk.refuseTyping(pid: Self.pid)
    try await Self.type(desk, Self.params())
    for keys in ["cmd+c", "cmd+x", "cmd+a", "cmd+v", "backspace", "a", "cmd+return"] {
      #expect(throws: DeviceError.self, "\(keys)") { try desk.allowsPress(KeyCombo.parse(keys), pid: Self.pid) }
    }
    for keys in ["return", "enter", "tab", "shift+tab", "escape"] {
      #expect(try desk.allowsPress(KeyCombo.parse(keys), pid: Self.pid), "\(keys)")
    }
    #expect(throws: DeviceError.self) { try desk.refuseTyping(pid: Self.pid) }
    // Another field has focus: its keys are its own.
    fake.focus = [Self.pid: 2]
    #expect(try desk.allowsPress(KeyCombo.parse("cmd+a"), pid: Self.pid) == false)
    try desk.refuseTyping(pid: Self.pid)
    // A new session keeps nothing of the last one's.
    fake.focus = [Self.pid: 1]
    desk.end()
    try desk.refuseTyping(pid: Self.pid)
  }

  /// In the field typed into, one plain left click alone; anywhere, a drag starting in it is refused.
  @Test func refusesClicksThatSelectOrOpenAMenuInTheFieldAndDragsOutOfIt() async throws {
    let desk = SecretDesk(Self.page())
    let inside = Point(x: 150, y: 210)
    let outside = Point(x: 600, y: 500)
    // Nothing typed: nothing refused.
    try desk.refuseClick(at: inside, button: .right, count: 2, modifiers: .shift, pid: Self.pid)
    try desk.refuseDrag(from: inside, pid: Self.pid)
    try await Self.type(desk, Self.params())
    try desk.refuseClick(at: inside, button: .left, count: 1, modifiers: [], pid: Self.pid)
    for (button, count, mods) in [(MouseButton.left, 2, Modifiers()), (.left, 3, []), (.right, 1, []), (.middle, 1, []), (.left, 1, .shift), (.left, 1, .command)] {
      #expect(throws: DeviceError.self, "\(button) \(count) \(mods)") { try desk.refuseClick(at: inside, button: button, count: count, modifiers: mods, pid: Self.pid) }
    }
    // Just around it, as a picture's mask is padded, counts as in it.
    #expect(throws: DeviceError.self) { try desk.refuseClick(at: Point(x: 98, y: 198), button: .left, count: 2, modifiers: [], pid: Self.pid) }
    try desk.refuseClick(at: outside, button: .right, count: 2, modifiers: .shift, pid: Self.pid)
    #expect(throws: DeviceError(.secretField, "KOS typed a secret into this field; nothing is dragged out of it.")) { try desk.refuseDrag(from: inside, pid: Self.pid) }
    try desk.refuseDrag(from: outside, pid: Self.pid)
  }

  /// While a field typed into has focus, a menu item is clicked only if it is on the short list, known by its Command
  /// key: Copy in any language, Services, Look Up or a search for the selection never are.
  @Test func clicksOnlyTheMenuItemsOnTheListWhileAFieldTypedIntoHasFocus() async throws {
    let fake = Self.page()
    let at = Point(x: 50, y: 10)
    fake.under = [(Rect(x: 0, y: 0, width: 300, height: 20), 31)]
    fake.attributes[30] = ["AXRole": "AXMenu"]
    func item(_ key: String?, mods: Int? = nil, title: String) {
      var a: [String: Any] = ["AXRole": "AXMenuItem", "AXTitle": title, "AXParent": 30]
      if let key { a["AXMenuItemCmdChar"] = key }
      if let mods { a["AXMenuItemCmdModifiers"] = mods }
      fake.attributes[32] = a
      fake.attributes[31] = ["AXRole": "AXStaticText", "AXParent": 32]
    }
    let desk = SecretDesk(fake)
    item("C", title: "Kopieren")
    try desk.refuseClick(at: at, button: .left, count: 1, modifiers: [], pid: Self.pid)
    try await Self.type(desk, Self.params())
    let refused: [(String?, Int?, String)] = [("C", nil, "Kopieren"), (nil, nil, "Select All"), (nil, nil, "Services"), ("E", nil, "Use Selection for Find"), (nil, nil, "Search with Google"), ("W", 1, "Close All")]
    for (key, mods, title) in refused {
      item(key, mods: mods, title: title)
      #expect(throws: DeviceError.self, "\(title)") { try desk.refuseClick(at: at, button: .left, count: 1, modifiers: [], pid: Self.pid) }
    }
    for (key, title) in [("N", "New Window"), ("W", "Close Tab"), ("R", "Reload Page"), ("[", "Back")] {
      item(key, title: title)
      try desk.refuseClick(at: at, button: .left, count: 1, modifiers: [], pid: Self.pid)
    }
    // A button that says Copy is not a menu item.
    fake.attributes[31] = ["AXRole": "AXButton", "AXTitle": "Copy"]
    try desk.refuseClick(at: at, button: .left, count: 1, modifiers: [], pid: Self.pid)
  }

  @Test func describesTheFieldInFocusWithoutItsValue() {
    let fake = Self.page()
    let desk = SecretDesk(fake)
    #expect(desk.describe(pid: Self.pid, bundle: Self.safari.bundle) == FieldIdentity(role: "AXTextField", secure: true, window: "Sign in to GitHub", label: "Password", place: .page(origin: "https://github.com", frames: [])))
    fake.focus = [Self.pid: 3]
    #expect(desk.describe(pid: Self.pid, bundle: Self.safari.bundle) == nil)
    #expect(!fake.asked.contains("AXValue"))
    #expect(SecretDesk<Fake>.originOf("https://GitHub.com:8443/x") == "https://github.com:8443")
    #expect(SecretDesk<Fake>.originOf("file:///etc/passwd") == nil)
  }

  /// keys.focus says a field is on a page with no origin it can vouch for, so KOS refuses before asking.
  @Test func encodesAPageWhoseOriginIsUnknown() throws {
    let unknown = try JSONSerialization.jsonObject(with: JSONEncoder().encode(FieldIdentity(role: "AXTextField", secure: true, place: .unknown))) as? [String: Any]
    #expect(unknown?["page"] as? Bool == true && unknown?["origin"] == nil)
    let framed = try JSONSerialization.jsonObject(with: JSONEncoder().encode(FieldIdentity(role: "AXTextField", secure: true, place: .page(origin: "https://a.example", frames: ["https://b.example"])))) as? [String: Any]
    #expect(framed?["origin"] as? String == "https://a.example" && framed?["frames"] as? [String] == ["https://b.example"])
    let native = try JSONSerialization.jsonObject(with: JSONEncoder().encode(FieldIdentity(role: "AXTextField", secure: true))) as? [String: Any]
    #expect(native?["page"] == nil)
  }

  // MARK: KOS's own pages and windows

  @Test func refusesActingOnKOSsOwnDashboardOrAnExtensionsPage() {
    let fake = Self.page()
    fake.under = [(Rect(x: 0, y: 0, width: 1200, height: 800), 2)]
    let desk = SecretDesk(fake)
    let hosts = ["127.0.0.1:4317", "kos.tail1234.ts.net"]
    for address in ["http://localhost:4317/inbox", "http://127.0.0.1:4317/", "https://kos.tail1234.ts.net/chat/1", "https://kos.tail1234.ts.net:8443/", "chrome-extension://abcdef/panel.html"] {
      fake.attributes[8]?["AXURL"] = address
      #expect(throws: DeviceError.self, "\(address)") { try desk.refuseOwnPage(at: Point(x: 10, y: 10), hosts: hosts, browser: true) }
      #expect(throws: DeviceError.self, "\(address)") { try desk.refuseOwnPage(focusedIn: Self.pid, hosts: hosts, browser: true) }
    }
    for address in ["http://localhost:3000/", "https://github.com/", "https://other.tail1234.ts.net/"] {
      fake.attributes[8]?["AXURL"] = address
      #expect(throws: Never.self, "\(address)") { try desk.refuseOwnPage(at: Point(x: 10, y: 10), hosts: hosts, browser: true) }
    }
  }

  @Test func aClickLandsOnKOSForMacsOwnWindowsUnlessTheyLetItThrough() {
    let me: Int32 = 1
    let overlay = WindowHit(pid: me, number: 10)
    let status = WindowHit(pid: me, number: 11)
    let safari = WindowHit(pid: 42, number: 12)
    let passes: (Int) -> Bool = { $0 == 10 }
    #expect(Landing.of([overlay, safari], me: me, passes: passes) == .app(42))
    #expect(Landing.of([overlay, status, safari], me: me, passes: passes) == .own)
    #expect(Landing.of([status], me: me, passes: passes) == .own)
    #expect(Landing.of([WindowHit(pid: 42, number: 13, clear: true), status], me: me, passes: passes) == .own)
    #expect(Landing.of([], me: me, passes: passes) == .nothing)
  }

  @Test func refusesTheKeysIntoKOSForMacsOwnMenuAndWindow() throws {
    for keys in ["ctrl+f2", "ctrl+f8", "cmd+opt+k"] {
      #expect(OwnKeys.refusal(try KeyCombo.parse(keys)) != nil, "\(keys)")
    }
    for keys in ["f2", "cmd+k", "return", "ctrl+f3"] {
      #expect(OwnKeys.refusal(try KeyCombo.parse(keys)) == nil, "\(keys)")
    }
  }

  // MARK: Where a field is, by app

  /// In an app that is not a browser, a web area at its own scheme is the app's window; one at http or https is a page.
  @Test func anAppsOwnWebAreaIsTheApp() {
    let fake = Self.page()
    fake.attributes[8]?["AXURL"] = "file:///Applications/Slack.app/index.html"
    let desk = SecretDesk(fake)
    #expect(desk.describe(pid: Self.pid, bundle: "com.tinyspeck.slackmacgap")?.place == .app)
    #expect(desk.describe(pid: Self.pid, bundle: Self.safari.bundle)?.place == .unknown)
    fake.attributes[8]?["AXURL"] = "https://app.slack.com/client"
    #expect(desk.describe(pid: Self.pid, bundle: "com.tinyspeck.slackmacgap")?.place == .page(origin: "https://app.slack.com", frames: []))
    // An address that cannot be read is unknown in any app.
    fake.attributes[8]?["AXURL"] = nil
    #expect(desk.describe(pid: Self.pid, bundle: "com.tinyspeck.slackmacgap")?.place == .unknown)
  }

  /// A web area seen on the way up, with the window never reached, is unknown; a native field with no window is the app's.
  @Test func aWebAreaShortOfItsWindowIsUnknown() {
    let fake = Self.page()
    fake.attributes[8]?["AXParent"] = nil
    let desk = SecretDesk(fake)
    #expect(desk.describe(pid: Self.pid, bundle: Self.safari.bundle)?.place == .unknown)
    fake.attributes[1]?["AXParent"] = nil
    #expect(desk.describe(pid: Self.pid, bundle: "com.example.native")?.place == .app)
  }

  /// In a browser, a page that cannot be walked up to its window may be the dashboard: refused there, not elsewhere.
  @Test func aBrowsersPageThatCannotBeToldIsRefused() throws {
    let fake = Self.page()
    fake.under = [(Rect(x: 0, y: 0, width: 1200, height: 800), 2)]
    fake.attributes[8]?["AXParent"] = nil
    let desk = SecretDesk(fake)
    #expect(throws: DeviceError.self) { try desk.refuseOwnPage(at: Point(x: 10, y: 10), hosts: [], browser: true) }
    try desk.refuseOwnPage(at: Point(x: 10, y: 10), hosts: [], browser: false)
  }

  @Test func knowsKOSsOwnHostsByNameAndPort() {
    let hosts = ["0.0.0.0:4317", "kos.example.ts.net", "localhost"]
    #expect(PagePlace.ownPage("http://127.0.0.1:4317/inbox", hosts: hosts) != nil)
    #expect(PagePlace.ownPage("https://kos.example.ts.net:8443/", hosts: hosts) != nil)
    #expect(PagePlace.ownPage("http://localhost:3000/", hosts: hosts) == nil)
    #expect(PagePlace.ownPage("https://github.com/", hosts: hosts) == nil)
    #expect(PagePlace.hostEntry(of: "http://127.0.0.1:4317/") == "127.0.0.1:4317")
    #expect(PagePlace.hostEntry(of: "https://kos.example.ts.net/") == "kos.example.ts.net:443")
  }

  // MARK: Between characters

  /// The page moving on while a secret is typed stops it at the next character.
  @Test func stopsWhenThePageMovesOnMidway() async {
    let fake = Self.page()
    let keys = Keys()
    keys.onPost = { if keys.chunks.count == 2 { fake.attributes[8]?["AXURL"] = "https://github.com/elsewhere" } }
    let error = await Self.refusal(SecretDesk(fake), Self.params(), keys: keys)
    #expect(error?.code == .partial && error?.message.contains("The page moved on.") == true)
    #expect(keys.chunks.count == 2)
  }

  /// Between characters only what is cheap is asked: the walk up to the window is made before the first and after the last.
  @Test func walksUpOnlyBeforeTheFirstAndAfterTheLast() async throws {
    let fake = Self.page()
    let keys = Keys()
    var walks: [Int] = []
    keys.onPost = { walks.append(fake.asked.filter { $0 == "AXParent" }.count) }
    try await Self.type(SecretDesk(fake), Self.params(), keys: keys)
    #expect(Set(walks.dropFirst()).count == 1)
  }

  // MARK: One window

  /// A field in a sheet on the session's window, or lying inside it, is in it.
  @Test func aSheetOnTheSessionsWindowIsInIt() async {
    let fake = Self.page()
    fake.attributes[1]?["AXWindow"] = 30
    fake.attributes[30] = ["AXRole": "AXWindow", "AXSubrole": "AXSheet", "AXParent": 9, "AXTitle": "Sign in to GitHub"]
    fake.frames[30] = Rect(x: 300, y: 100, width: 400, height: 300)
    let desk = SecretDesk(fake)
    #expect(await Self.refusal(desk, Self.params(), scene: { Self.scene(window: Self.windowFrame) }) == nil)
    fake.attributes[30]?["AXParent"] = nil
    #expect(await Self.refusal(desk, Self.params(), scene: { Self.scene(window: Self.windowFrame) }) == nil)
    fake.frames[1] = Rect(x: 1300, y: 200, width: 300, height: 30)
    #expect(await Self.refusal(desk, Self.params(), scene: { Self.scene(window: Self.windowFrame) })?.code == .field)
  }

  // MARK: A page that hid a field

  @Test func aPageThatHidAFieldIsBlackedOutForTenMinutesAtMost() async throws {
    var clock = Date(timeIntervalSince1970: 1_000_000)
    let fake = Self.page()
    let desk = SecretDesk(fake) { clock }
    try await Self.type(desk, Self.params())
    fake.frames[1] = nil
    fake.focus = [Self.pid: 2]
    #expect(try desk.masks(pid: Self.pid).pageMasked)
    clock += 599
    #expect(try desk.masks(pid: Self.pid).pageMasked)
    clock += 1
    #expect(try desk.masks(pid: Self.pid) == SecretMasks(rects: []))
  }
}
