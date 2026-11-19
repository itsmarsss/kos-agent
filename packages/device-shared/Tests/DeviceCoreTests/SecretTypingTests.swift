import Foundation
import Testing

@testable import DeviceCore

/// A saved secret typed on the Mac: refused into the wrong app, the wrong field or the wrong page, typed in chunks
/// from a buffer zeroed after, answered with an outcome alone, and the field kept out of pictures and copies.
@Suite("A secret typed")
struct SecretTypingTests {
  /// An app's Accessibility tree, by element id, and which element has focus in each app. Every attribute asked is
  /// written down, so a test can say the field's value is never read.
  final class Fake: FieldAccess {
    var attributes: [Int: [String: Any]] = [:]
    var frames: [Int: Rect] = [:]
    var focus: [Int32: Int] = [:]
    private(set) var asked: [String] = []

    func focused(pid: Int32) -> Int? { focus[pid] }
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
    func frame(of element: Int) -> Rect? { frames[element] }
  }

  static let canary = "pw-Canary-\u{1F511}-91zq-long-enough"
  static let safari = FrontApp(name: "Safari", bundle: "com.apple.Safari")
  static let pid: Int32 = 42

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
    fake.frames = [1: Rect(x: 100, y: 200, width: 300, height: 30), 2: Rect(x: 100, y: 150, width: 300, height: 30)]
    fake.focus = [pid: 1]
    return fake
  }

  static func params(
    field: String = "password", bundle: String = "com.apple.Safari", apps: [String] = ["com.apple.Safari"], secure: Bool = true,
    window: String? = "Sign in to GitHub", origin: String? = "https://github.com", approved: String = "s1", text: String = canary
  ) -> SecretTypeParams {
    SecretTypeParams(
      session: "s1", approved: approved, text: text, field: field, app: SecretApp(bundle: bundle), apps: apps,
      expect: ExpectedField(role: "AXTextField", secure: secure, window: window), origin: origin)
  }

  /// What was posted, chunk by chunk.
  final class Keys {
    var chunks: [[UInt16]] = []
    var failAt: Int?
    var typed: String { String(decoding: chunks.flatMap { $0 }, as: UTF16.self) }

    func post(_ units: UnsafeBufferPointer<UInt16>) throws {
      if chunks.count == failAt { throw DeviceError(.internal, "the key event could not be made") }
      chunks.append(Array(units))
    }
  }

  /// keys.secret with these params into the fake, as the controller calls it.
  @discardableResult
  static func type(
    _ desk: SecretDesk<Fake>, _ p: SecretTypeParams, keys: Keys = Keys(), buffer: SecretBuffer? = nil, front: FrontApp? = safari,
    ownWindow: Bool = false, hidden: Bool = false
  ) async throws -> SecretTypedResult {
    try await desk.type(
      p, buffer: buffer ?? SecretBuffer(p.text), live: "s1", scene: { SecretScene(front: front, pid: front == nil ? nil : pid, own: ownWindow, hidden: hidden) },
      post: keys.post, between: {})
  }

  static func refusal(_ desk: SecretDesk<Fake>, _ p: SecretTypeParams, front: FrontApp? = safari, ownWindow: Bool = false, hidden: Bool = false) async -> DeviceError? {
    do {
      try await type(desk, p, front: front, ownWindow: ownWindow, hidden: hidden)
      return nil
    } catch let error as DeviceError {
      return error
    } catch {
      return DeviceError(.internal, "\(error)")
    }
  }

  @Test func typesTheValueInChunksIntoTheApprovedField() async throws {
    let keys = Keys()
    let desk = SecretDesk(Self.page())
    let result = try await Self.type(desk, Self.params(), keys: keys)
    #expect(result == SecretTypedResult())
    #expect(keys.typed == Self.canary)
    #expect(keys.chunks.allSatisfy { $0.count <= Typing.chunkUnits })
    // The key's surrogate pair is never split between two events.
    #expect(keys.chunks.allSatisfy { !UTF16.isLeadSurrogate($0.last!) })
  }

  @Test func refusesAnotherAppThanTheOneApprovedOrAllowed() async {
    let desk = SecretDesk(Self.page())
    let chrome = FrontApp(name: "Google Chrome", bundle: "com.google.Chrome")
    #expect(await Self.refusal(desk, Self.params(), front: chrome)?.code == .target)
    #expect(await Self.refusal(desk, Self.params(apps: ["com.google.Chrome"]))?.code == .target)
    #expect(await Self.refusal(desk, Self.params(), front: nil)?.code == .target)
    #expect(await Self.refusal(desk, Self.params(), ownWindow: true)?.code == .target)
    #expect(await Self.refusal(desk, Self.params(), hidden: true)?.code == .hiddenApp)
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

  @Test func refusesAPageOnAnotherSiteThanTheOneApproved() async {
    let desk = SecretDesk(Self.page())
    #expect(await Self.refusal(desk, Self.params(origin: "https://github.com.evil.example"))?.code == .origin)
    // A field on a page is never typed into as though it were an app's own.
    #expect(await Self.refusal(desk, Self.params(origin: nil))?.code == .origin)
  }

  @Test func takesACardNumberOnlyWhereTheFieldSaysSo() {
    let named = FieldIdentity(role: "AXTextField", secure: false, label: "Card number")
    let other = FieldIdentity(role: "AXTextField", secure: false, label: "Search orders")
    let unnamed = FieldIdentity(role: "AXTextField", secure: false)
    #expect(SecretDesk<Fake>.refusal(of: "card-number", into: named) == nil)
    #expect(SecretDesk<Fake>.refusal(of: "card-number", into: other) != nil)
    #expect(SecretDesk<Fake>.refusal(of: "card-number", into: unnamed) == nil)
    #expect(SecretDesk<Fake>.refusal(of: "card-cvc", into: FieldIdentity(role: "AXTextField", secure: false, placeholder: "CVV")) == nil)
    #expect(SecretDesk<Fake>.refusal(of: "card-cvc", into: other) != nil)
  }

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

  @Test func answersAnOutcomeAloneAndNeverTheValue() async throws {
    let body = try JSONSerialization.jsonObject(with: Outbound.reply(id: 3, result: SecretTypedResult())) as? [String: Any]
    #expect(body?["result"] as? [String: Bool] == ["typed": true])
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

  @Test func stopsAtTheFirstChunkAfterFocusMovesAndKeepsWhatWasTyped() async throws {
    let fake = Self.page()
    let desk = SecretDesk(fake)
    let keys = Keys()
    let buffer = SecretBuffer(Self.canary)
    var front = Self.safari
    var own = false
    // Focus moves to the username field after the first chunk: nothing more is typed.
    let moved: () async throws -> Void = { if keys.chunks.count == 1 { fake.focus = [Self.pid: 2] } }
    await #expect(throws: DeviceError(.field, "The field with focus is not the one the owner approved.")) {
      try await desk.type(
        Self.params(), buffer: buffer, live: "s1", scene: { SecretScene(front: front, pid: Self.pid, own: own, hidden: false) },
        post: keys.post, between: moved)
    }
    #expect(keys.chunks.count == 1 && buffer.isWiped)
    // What did go in is kept from pictures all the same.
    #expect(try desk.masks(pid: Self.pid).contains(Rect(x: 100, y: 200, width: 300, height: 30)))
    // Another app coming to the front, or KOS for Mac's own menu opening, stops it too.
    let changes: [() -> Void] = [{ front = FrontApp(name: "Notes", bundle: "com.apple.Notes") }, { own = true }]
    for change in changes {
      fake.focus = [Self.pid: 1]
      front = Self.safari
      own = false
      let more = Keys()
      await #expect(throws: DeviceError.self) {
        try await desk.type(
          Self.params(), buffer: SecretBuffer(Self.canary), live: "s1", scene: { SecretScene(front: front, pid: Self.pid, own: own, hidden: false) },
          post: more.post, between: { if more.chunks.count == 1 { change() } })
      }
      #expect(more.chunks.count == 1)
    }
  }

  @Test func refusesASecretThatWouldActRatherThanType() async {
    let desk = SecretDesk(Self.page())
    #expect(await Self.refusal(desk, Self.params(text: "two\tparts"))?.code == .badRequest)
    #expect(await Self.refusal(desk, Self.params(text: ""))?.code == .badRequest)
  }

  @Test func blacksOutTheFieldsTypedIntoAndAFocusedPasswordField() async throws {
    let fake = Self.page()
    let desk = SecretDesk(fake)
    // Nothing typed yet: the password field in focus is blacked out all the same.
    #expect(try desk.masks(pid: Self.pid) == [Rect(x: 100, y: 200, width: 300, height: 30)])
    fake.focus = [Self.pid: 2]
    #expect(try desk.masks(pid: Self.pid).isEmpty)
    try await Self.type(desk, Self.params(field: "username", secure: false))
    fake.focus = [Self.pid: 1]
    try await Self.type(desk, Self.params())
    #expect(try desk.masks(pid: Self.pid) == [Rect(x: 100, y: 150, width: 300, height: 30), Rect(x: 100, y: 200, width: 300, height: 30)])
    // A field typed into that is not in focus and cannot be found is let be; one in focus refuses the picture.
    fake.frames[2] = nil
    #expect(try desk.masks(pid: Self.pid) == [Rect(x: 100, y: 200, width: 300, height: 30)])
    fake.focus = [Self.pid: 2]
    #expect(throws: DeviceError(.secretField, "A field KOS typed a secret into has focus and cannot be found, so no picture is taken.")) { try desk.masks(pid: Self.pid) }
    // So does a password field in focus that cannot be found, typed into or not.
    desk.end()
    fake.focus = [Self.pid: 1]
    fake.frames[1] = nil
    #expect(throws: DeviceError.self) { try desk.masks(pid: Self.pid) }
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
    #expect(throws: DeviceError.self) { try desk.refuseMenuItem(role: "AXMenuItem", commandKey: "C", title: "Kopieren", pid: Self.pid) }
    #expect(throws: DeviceError.self) { try desk.refuseMenuItem(role: "AXMenuItem", commandKey: nil, title: "Select All", pid: Self.pid) }
    try desk.refuseMenuItem(role: "AXMenuItem", commandKey: "N", title: "New Window", pid: Self.pid)
    try desk.refuseMenuItem(role: "AXButton", commandKey: nil, title: "Copy", pid: Self.pid)
    // Another field has focus: its keys are its own.
    fake.focus = [Self.pid: 2]
    #expect(try desk.allowsPress(KeyCombo.parse("cmd+a"), pid: Self.pid) == false)
    try desk.refuseTyping(pid: Self.pid)
    // A new session keeps nothing of the last one's.
    fake.focus = [Self.pid: 1]
    desk.end()
    try desk.refuseTyping(pid: Self.pid)
  }

  @Test func describesTheFieldInFocusWithoutItsValue() {
    let fake = Self.page()
    let desk = SecretDesk(fake)
    #expect(desk.describe(pid: Self.pid) == FieldIdentity(role: "AXTextField", secure: true, window: "Sign in to GitHub", label: "Password", origin: "https://github.com"))
    fake.focus = [Self.pid: 3]
    #expect(desk.describe(pid: Self.pid) == nil)
    #expect(!fake.asked.contains("AXValue"))
    #expect(SecretDesk<Fake>.originOf("https://GitHub.com:8443/x") == "https://github.com:8443")
    #expect(SecretDesk<Fake>.originOf("file:///etc/passwd") == nil)
  }
}
