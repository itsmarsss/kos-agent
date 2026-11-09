import Testing

@testable import DeviceCore

/// The owner's selection is read from the app beside the chat: asked for in apps that keep their tree off, found
/// where the app holds it, and never read from a password field, a hidden app, or without Accessibility.
@MainActor
@Suite("Selection")
struct SelectionTests {
  /// An app's Accessibility tree, by element id: 0 is the app.
  final class Fake: SelectionAccess {
    var trusted = true
    var answering = true
    var attributes: [Int: [String: Any]] = [:]
    var children: [Int: [Int]] = [:]
    var marked: [Int: String] = [:]
    /// Attributes the app takes when set, and what happens when it does.
    var settable: Set<String> = []
    var onSet: ((String, Bool) -> Void)?
    private(set) var sets: [(String, Bool)] = []

    func application(_ pid: Int32) -> Int { 0 }
    func element(_ attribute: String, of element: Int) -> Int? { attributes[element]?[attribute] as? Int }
    func string(_ attribute: String, of element: Int) -> String? { attributes[element]?[attribute] as? String }
    func bool(_ attribute: String, of element: Int) -> Bool? { attributes[element]?[attribute] as? Bool }
    func set(_ attribute: String, _ value: Bool, on element: Int) -> Bool {
      guard settable.contains(attribute) else { return false }
      sets.append((attribute, value))
      attributes[element, default: [:]][attribute] = value
      onSet?(attribute, value)
      return true
    }
    func markedText(of element: Int) -> String? { marked[element] }
    func children(of element: Int) -> [Int] { children[element] ?? [] }

    func sets(_ attribute: String) -> [Bool] { sets.filter { $0.0 == attribute }.map(\.1) }
  }

  private let chrome = SelectionApp(pid: 7, bundle: "com.google.Chrome")
  private let slack = SelectionApp(pid: 8, bundle: "com.tinyspeck.slackmacgap")
  private let notes = SelectionApp(pid: 9, bundle: "com.apple.Notes")

  private func read(
    _ fake: Fake, _ app: SelectionApp, hidden: Bool = false, secure: @escaping () -> Bool = { false },
    pause: @escaping () -> Void = {}
  ) async -> (SelectionRead, Int) {
    var paused = 0
    let reader = SelectionReader(fake)
    let read = await reader.read(app, hidden: hidden, secureInput: secure) {
      paused += 1
      pause()
    }
    return (read, paused)
  }

  @Test func aFocusedFieldsSelectionIsRead() async {
    let fake = Fake()
    fake.attributes = [0: ["AXFocusedUIElement": 1], 1: ["AXRole": "AXTextArea", "AXSelectedText": "  the dog \n"]]
    let (read, paused) = await read(fake, notes)
    #expect(read == .text("the dog"))
    #expect(paused == 0)
    #expect(fake.sets("AXManualAccessibility").isEmpty)
  }

  /// An Electron app answers only once asked for its tree: asked, given a moment, and read again.
  @Test func anElectronAppIsAskedForItsTreeAndReadAgain() async {
    let fake = Fake()
    fake.settable = ["AXManualAccessibility"]
    var built = false
    let (read, paused) = await read(fake, slack, pause: {
      built = true
      fake.attributes = [0: ["AXFocusedUIElement": 1, "AXManualAccessibility": true], 1: ["AXSelectedText": "ship it"]]
    })
    #expect(built)
    #expect(read == .text("ship it"))
    #expect(paused == 1)
    #expect(fake.sets("AXManualAccessibility") == [true])
    #expect(fake.sets("AXEnhancedUserInterface").isEmpty)
  }

  /// An app that took it once keeps its tree on: not asked or waited on again when nothing is selected.
  @Test func anAppAskedOnceIsNotAskedAgain() async {
    let fake = Fake()
    fake.settable = ["AXManualAccessibility"]
    let reader = SelectionReader(fake)
    var paused = 0
    #expect(await reader.read(slack, hidden: false, secureInput: { false }) { paused += 1 } == .nothing)
    #expect(await reader.read(slack, hidden: false, secureInput: { false }) { paused += 1 } == .nothing)
    #expect(paused == 1)
    #expect(fake.sets("AXManualAccessibility") == [true])
  }

  /// A Chromium browser that does not take AXManualAccessibility gets AXEnhancedUserInterface for the read, then
  /// has it off again as it was.
  @Test func chromeIsEnhancedForTheReadAndRestored() async {
    let fake = Fake()
    fake.settable = ["AXEnhancedUserInterface"]
    let (read, _) = await read(fake, chrome, pause: {
      fake.attributes[0]?["AXFocusedUIElement"] = 1
      fake.attributes[1] = ["AXSelectedText": "a headline"]
    })
    #expect(read == .text("a headline"))
    #expect(fake.sets("AXEnhancedUserInterface") == [true, false])
  }

  /// Already on, by a screen reader or the owner: left on.
  @Test func anEnhancedChromeIsLeftAsItWas() async {
    let fake = Fake()
    fake.settable = ["AXEnhancedUserInterface"]
    fake.attributes = [0: ["AXEnhancedUserInterface": true]]
    let (read, paused) = await read(fake, chrome)
    #expect(read == .nothing)
    #expect(paused == 0)
    #expect(fake.sets("AXEnhancedUserInterface").isEmpty)
  }

  /// Only a Chromium browser is enhanced: in any other app it can change how windows move.
  @Test func anotherAppIsNeverEnhanced() async {
    let fake = Fake()
    fake.settable = ["AXEnhancedUserInterface"]
    let (read, paused) = await read(fake, notes)
    #expect(read == .nothing)
    #expect(paused == 0)
    #expect(fake.sets("AXEnhancedUserInterface").isEmpty)
  }

  /// Web content holds the selection in a web area around the focused link, as a marker range.
  @Test func aParentsMarkedTextIsRead() async {
    let fake = Fake()
    fake.attributes = [
      0: ["AXFocusedUIElement": 3],
      3: ["AXRole": "AXLink", "AXParent": 2],
      2: ["AXRole": "AXWebArea", "AXParent": 1],
      1: ["AXRole": "AXWindow"],
    ]
    fake.marked = [2: "the quoted paragraph"]
    let (read, _) = await read(fake, chrome)
    #expect(read == .text("the quoted paragraph"))
  }

  /// Nothing focused that holds it: the focused window is looked through, a password field passed over.
  @Test func theWindowIsLookedThroughLast() async {
    let fake = Fake()
    fake.attributes = [
      0: ["AXFocusedUIElement": 1, "AXFocusedWindow": 10],
      1: ["AXRole": "AXButton", "AXParent": 10],
      10: ["AXRole": "AXWindow"],
      11: ["AXRole": "AXSecureTextField", "AXSelectedText": "hunter2"],
      12: ["AXRole": "AXGroup"],
      13: ["AXRole": "AXStaticText", "AXSelectedText": "found it"],
    ]
    fake.children = [10: [11, 12], 12: [13]]
    let (read, _) = await read(fake, notes)
    #expect(read == .text("found it"))
  }

  @Test func aLongSelectionIsCut() async {
    let fake = Fake()
    fake.attributes = [0: ["AXFocusedUIElement": 1], 1: ["AXSelectedText": String(repeating: "a", count: 5_000)]]
    let (read, _) = await read(fake, notes)
    #expect(read == .text(String(repeating: "a", count: 4_000)))
  }

  @Test func aPasswordFieldIsRefused() async {
    let fake = Fake()
    fake.attributes = [0: ["AXFocusedUIElement": 1], 1: ["AXSubrole": "AXSecureTextField", "AXSelectedText": "hunter2"]]
    #expect(await read(fake, notes).0 == .refused)
    fake.attributes[1] = ["AXRole": "AXSecureTextField", "AXSelectedText": "hunter2"]
    #expect(await read(fake, notes).0 == .refused)
  }

  /// Secure input on, at the start or by the time a tree is built: nothing is read.
  @Test func secureInputIsRefusedBeforeAndAfterTheWait() async {
    let fake = Fake()
    fake.attributes = [0: ["AXFocusedUIElement": 1], 1: ["AXSelectedText": "hunter2"]]
    #expect(await read(fake, notes, secure: { true }).0 == .refused)

    let later = Fake()
    later.settable = ["AXManualAccessibility"]
    var secure = false
    let (read, _) = await read(later, slack, secure: { secure }, pause: {
      secure = true
      later.attributes = [0: ["AXFocusedUIElement": 1], 1: ["AXSelectedText": "hunter2"]]
    })
    #expect(read == .refused)
  }

  @Test func aHiddenAppIsNeverRead() async {
    let fake = Fake()
    fake.settable = ["AXManualAccessibility"]
    fake.attributes = [0: ["AXFocusedUIElement": 1], 1: ["AXSelectedText": "a secret"]]
    #expect(await read(fake, notes, hidden: true).0 == .refused)
    #expect(fake.sets("AXManualAccessibility").isEmpty)
  }

  /// Without Accessibility nothing can be read, and the window says why.
  @Test func withoutAccessibilityItSaysSo() async {
    let fake = Fake()
    fake.trusted = false
    fake.attributes = [0: ["AXFocusedUIElement": 1], 1: ["AXSelectedText": "the dog"]]
    #expect(await read(fake, notes).0 == .untrusted)
  }

  /// An app that stopped answering is not asked more, nor flagged and waited on.
  @Test func anAppThatDoesNotAnswerIsLeft() async {
    let fake = Fake()
    fake.answering = false
    fake.settable = ["AXManualAccessibility"]
    let (read, paused) = await read(fake, slack)
    #expect(read == .nothing)
    #expect(paused == 0)
  }

  /// "This" is the app in front, or while KOS for Mac is, the one the owner was in before it.
  @Test func theAppBesideIsTheLastOtherThanThisOne() {
    var front = FrontTracker<String> { $0 == "kos" }
    #expect(front.beside(front: "kos") == nil)
    front.note("Notes")
    front.note("kos")
    #expect(front.last == "Notes")
    #expect(front.beside(front: "kos") == "Notes")
    #expect(front.beside(front: "Slack") == "Slack")
    front.note("Slack")
    #expect(front.beside(front: "kos") == "Slack")
    #expect(front.beside(front: nil) == nil)
  }
}
