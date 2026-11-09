import Foundation
import Testing

@testable import DeviceCore

/// The owner's selection is read from the app beside the chat: asked for in apps that keep their tree off, found
/// where the app holds it, within a time budget, and never read from a password field, a hidden app, or without
/// Accessibility.
@Suite("Selection")
struct SelectionTests {
  /// An app's Accessibility tree, by element id: 0 is the app. Each question takes `cost` of its clock, and after
  /// `answers` questions the app stops answering, as one that timed out.
  final class Fake: SelectionAccess {
    var trusted = true
    private(set) var answering = true
    var attributes: [Int: [String: Any]] = [:]
    var children: [Int: [Int]] = [:]
    var marked: [Int: String] = [:]
    /// Attributes the app takes when set.
    var settable: Set<String> = []
    private(set) var sets: [(String, Bool)] = []
    var cost: TimeInterval = 0
    var answers = Int.max
    /// How many times the app refuses to turn a flag off before it takes it.
    var refusesOff = 0
    var gone: Set<Int32> = []
    private(set) var asked = 0
    private(set) var clock: TimeInterval = 0

    func application(_ pid: Int32) -> Int {
      answering = true
      return 0
    }
    func element(_ attribute: String, of element: Int) -> Int? { ask { attributes[element]?[attribute] as? Int } }
    func string(_ attribute: String, of element: Int) -> String? { ask { attributes[element]?[attribute] as? String } }
    func bool(_ attribute: String, of element: Int) -> Bool? { ask { attributes[element]?[attribute] as? Bool } }
    func set(_ attribute: String, _ value: Bool, on element: Int) -> Bool {
      guard settable.contains(attribute), ask({ true }) == true else { return false }
      if !value, refusesOff > 0 {
        refusesOff -= 1
        return false
      }
      sets.append((attribute, value))
      attributes[element, default: [:]][attribute] = value
      return true
    }
    func markedText(of element: Int) -> String? { ask { marked[element] } }
    func children(of element: Int) -> [Int] { ask { children[element] } ?? [] }
    func running(_ pid: Int32) -> Bool { !gone.contains(pid) }

    func sets(_ attribute: String) -> [Bool] { sets.filter { $0.0 == attribute }.map(\.1) }
    func pass(_ time: TimeInterval) { clock += time }

    private func ask<T>(_ answer: () -> T?) -> T? {
      guard answering else { return nil }
      asked += 1
      clock += cost
      guard asked <= answers else {
        answering = false
        return nil
      }
      return answer()
    }
  }

  private let chrome = SelectionApp(pid: 7, bundle: "com.google.Chrome")
  private let slack = SelectionApp(pid: 8, bundle: "com.tinyspeck.slackmacgap", chromiumBased: true)
  private let notes = SelectionApp(pid: 9, bundle: "com.apple.Notes")

  private func reader(_ fake: Fake) -> SelectionReader<Fake> {
    SelectionReader(fake) { fake.clock }
  }

  private func read(
    _ fake: Fake, _ app: SelectionApp, hidden: Bool = false, secure: () -> Bool = { false }, pause: () -> Void = {}
  ) -> (SelectionRead?, Int) {
    var paused = 0
    let read = reader(fake).read(app, hidden: hidden, secureInput: secure) {
      paused += 1
      pause()
    }
    return (read, paused)
  }

  @Test func aFocusedFieldsSelectionIsRead() {
    let fake = Fake()
    fake.attributes = [0: ["AXFocusedUIElement": 1], 1: ["AXRole": "AXTextArea", "AXSelectedText": "  the dog \n"]]
    let (read, paused) = read(fake, notes)
    #expect(read == .text("the dog"))
    #expect(paused == 0)
    #expect(fake.sets("AXManualAccessibility").isEmpty)
  }

  /// An Electron app answers only once asked for its tree: asked, given a moment, and read again.
  @Test func anElectronAppIsAskedForItsTreeAndReadAgain() {
    let fake = Fake()
    fake.settable = ["AXManualAccessibility"]
    var built = false
    let (read, paused) = read(fake, slack, pause: {
      built = true
      fake.attributes = [0: ["AXFocusedUIElement": 1, "AXManualAccessibility": true], 1: ["AXSelectedText": "ship it"]]
    })
    #expect(built)
    #expect(read == .text("ship it"))
    #expect(paused == 1)
    #expect(fake.sets("AXManualAccessibility") == [true, false])
    #expect(fake.sets("AXEnhancedUserInterface").isEmpty)
  }

  /// The tree is on for the read alone: off again after each, so it is asked for again on the next.
  @Test func anElectronAppsTreeIsTurnedOffAfterEachRead() {
    let fake = Fake()
    fake.settable = ["AXManualAccessibility"]
    let reader = reader(fake)
    var paused = 0
    #expect(reader.read(slack, hidden: false, secureInput: { false }) { paused += 1 } == .nothing)
    #expect(fake.attributes[0]?["AXManualAccessibility"] as? Bool == false)
    #expect(reader.read(slack, hidden: false, secureInput: { false }) { paused += 1 } == .nothing)
    #expect(paused == 2)
    #expect(fake.sets("AXManualAccessibility") == [true, false, true, false])
  }

  /// An app that will not turn its tree off at once is asked again.
  @Test func aFlagRefusedOffIsAskedAgain() {
    let fake = Fake()
    fake.settable = ["AXManualAccessibility"]
    fake.refusesOff = 1
    let reader = reader(fake)
    #expect(reader.read(slack, hidden: false, secureInput: { false }) {} == .nothing)
    #expect(fake.sets("AXManualAccessibility") == [true, false])
    #expect(reader.unrestored.isEmpty)
  }

  /// Refused twice, the flag is kept, and put back at the next read, whichever app that is of.
  @Test func aFlagLeftOnIsPutBackAtTheNextRead() {
    let fake = Fake()
    fake.settable = ["AXManualAccessibility"]
    fake.refusesOff = 2
    let reader = reader(fake)
    #expect(reader.read(slack, hidden: false, secureInput: { false }) {} == .nothing)
    #expect(fake.sets("AXManualAccessibility") == [true])
    #expect(reader.unrestored == [8: ["AXManualAccessibility"]])
    #expect(reader.read(notes, hidden: true, secureInput: { false }) {} == .refused)
    #expect(fake.sets("AXManualAccessibility") == [true, false])
    #expect(reader.unrestored.isEmpty)
  }

  /// Chrome's enhanced mode, refused off, is put back as KOS for Mac quits; one in an app that has quit is let go.
  @Test func aFlagLeftOnIsPutBackOnQuitting() {
    let fake = Fake()
    fake.settable = ["AXEnhancedUserInterface"]
    fake.refusesOff = 2
    let reader = reader(fake)
    #expect(reader.read(chrome, hidden: false, secureInput: { false }) {} == .nothing)
    #expect(reader.unrestored == [7: ["AXEnhancedUserInterface"]])
    // Still refused: kept for later.
    fake.refusesOff = 1
    reader.restore()
    #expect(reader.unrestored == [7: ["AXEnhancedUserInterface"]])
    reader.restore()
    #expect(fake.sets("AXEnhancedUserInterface") == [true, false])
    #expect(reader.unrestored.isEmpty)

    fake.refusesOff = 2
    _ = reader.read(chrome, hidden: false, secureInput: { false }) {}
    fake.gone = [7]
    reader.restore()
    #expect(reader.unrestored.isEmpty)
    #expect(fake.sets("AXEnhancedUserInterface") == [true, false, true])
  }

  /// Already on, by a screen reader or the owner: left on.
  @Test func anOpenTreeIsLeftAsItWas() {
    let fake = Fake()
    fake.settable = ["AXManualAccessibility"]
    fake.attributes = [0: ["AXManualAccessibility": true]]
    let (read, paused) = read(fake, slack)
    #expect(read == .nothing)
    #expect(paused == 0)
    #expect(fake.sets("AXManualAccessibility").isEmpty)
  }

  /// Only an app built on Chromium is asked for its tree: any other is read as it is.
  @Test func anotherAppIsNeverAskedForItsTree() {
    let fake = Fake()
    fake.settable = ["AXManualAccessibility", "AXEnhancedUserInterface"]
    let (read, paused) = read(fake, notes)
    #expect(read == .nothing)
    #expect(paused == 0)
    #expect(fake.sets.isEmpty)
  }

  /// A Chromium browser that does not take AXManualAccessibility gets AXEnhancedUserInterface for the read, then
  /// has it off again as it was.
  @Test func chromeIsEnhancedForTheReadAndRestored() {
    let fake = Fake()
    fake.settable = ["AXEnhancedUserInterface"]
    let (read, _) = read(fake, chrome, pause: {
      fake.attributes[0]?["AXFocusedUIElement"] = 1
      fake.attributes[1] = ["AXSelectedText": "a headline"]
    })
    #expect(read == .text("a headline"))
    #expect(fake.sets("AXEnhancedUserInterface") == [true, false])
  }

  /// Already on, by a screen reader or the owner: left on.
  @Test func anEnhancedChromeIsLeftAsItWas() {
    let fake = Fake()
    fake.settable = ["AXEnhancedUserInterface"]
    fake.attributes = [0: ["AXEnhancedUserInterface": true]]
    let (read, paused) = read(fake, chrome)
    #expect(read == .nothing)
    #expect(paused == 0)
    #expect(fake.sets("AXEnhancedUserInterface").isEmpty)
  }

  /// Only a Chromium browser is enhanced: in an Electron app it can change how windows move.
  @Test func anElectronAppIsNeverEnhanced() {
    let fake = Fake()
    fake.settable = ["AXEnhancedUserInterface"]
    let (read, paused) = read(fake, slack)
    #expect(read == .nothing)
    #expect(paused == 0)
    #expect(fake.sets("AXEnhancedUserInterface").isEmpty)
  }

  /// Web content holds the selection in a web area around the focused link, as a marker range.
  @Test func aParentsMarkedTextIsRead() {
    let fake = Fake()
    fake.attributes = [
      0: ["AXFocusedUIElement": 3],
      3: ["AXRole": "AXLink", "AXParent": 2],
      2: ["AXRole": "AXWebArea", "AXParent": 1],
      1: ["AXRole": "AXWindow"],
    ]
    fake.marked = [2: "the quoted paragraph"]
    let (read, _) = read(fake, chrome)
    #expect(read == .text("the quoted paragraph"))
  }

  /// Nothing focused that holds it: the focused window is looked through, a password field passed over.
  @Test func theWindowIsLookedThroughLast() {
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
    let (read, _) = read(fake, notes)
    #expect(read == .text("found it"))
  }

  @Test func aLongSelectionIsCut() {
    let fake = Fake()
    fake.attributes = [0: ["AXFocusedUIElement": 1], 1: ["AXSelectedText": String(repeating: "a", count: 5_000)]]
    let (read, _) = read(fake, notes)
    #expect(read == .text(String(repeating: "a", count: 4_000)))
  }

  @Test func aPasswordFieldIsRefused() {
    let fake = Fake()
    fake.attributes = [0: ["AXFocusedUIElement": 1], 1: ["AXSubrole": "AXSecureTextField", "AXSelectedText": "hunter2"]]
    #expect(read(fake, notes).0 == .refused)
    fake.attributes[1] = ["AXRole": "AXSecureTextField", "AXSelectedText": "hunter2"]
    #expect(read(fake, notes).0 == .refused)
  }

  /// Secure input on, at the start or by the time a tree is built: nothing is read.
  @Test func secureInputIsRefusedBeforeAndAfterTheWait() {
    let fake = Fake()
    fake.attributes = [0: ["AXFocusedUIElement": 1], 1: ["AXSelectedText": "hunter2"]]
    #expect(read(fake, notes, secure: { true }).0 == .refused)

    let later = Fake()
    later.settable = ["AXManualAccessibility"]
    var secure = false
    let (read, _) = read(later, slack, secure: { secure }, pause: {
      secure = true
      later.attributes = [0: ["AXFocusedUIElement": 1], 1: ["AXSelectedText": "hunter2"]]
    })
    #expect(read == .refused)
  }

  @Test func aHiddenAppIsNeverRead() {
    let fake = Fake()
    fake.settable = ["AXManualAccessibility"]
    fake.attributes = [0: ["AXFocusedUIElement": 1], 1: ["AXSelectedText": "a secret"]]
    #expect(read(fake, notes, hidden: true).0 == .refused)
    #expect(fake.sets("AXManualAccessibility").isEmpty)
  }

  /// Without Accessibility nothing can be read, and the window says why.
  @Test func withoutAccessibilityItSaysSo() {
    let fake = Fake()
    fake.trusted = false
    fake.attributes = [0: ["AXFocusedUIElement": 1], 1: ["AXSelectedText": "the dog"]]
    #expect(read(fake, notes).0 == .untrusted)
  }

  /// An app that times out part way through a read is asked nothing more on it, nor flagged and waited on.
  @Test func anAppThatDoesNotAnswerIsLeft() {
    let fake = Fake()
    fake.settable = ["AXManualAccessibility"]
    // A deep focused element and a full window: the app answers three questions, then times out.
    fake.attributes = [0: ["AXFocusedUIElement": 1, "AXFocusedWindow": 10]]
    for id in 1...6 { fake.attributes[id] = ["AXRole": "AXGroup", "AXParent": id + 1] }
    fake.attributes[7] = ["AXSelectedText": "out of reach"]
    fake.answers = 3
    let (read, paused) = read(fake, slack)
    #expect(read == .nothing)
    #expect(paused == 0)
    #expect(fake.asked == 4)
    #expect(fake.sets("AXManualAccessibility").isEmpty)
  }

  /// The questions of a read have a budget: an app slow on each is left when it is spent, the window not walked out.
  @Test func theBudgetStopsTheWalk() {
    let fake = Fake()
    fake.cost = 0.01
    fake.attributes = [0: ["AXFocusedWindow": 10]]
    fake.children = [10: Array(11...200)]
    fake.attributes[200] = ["AXSelectedText": "past the budget"]
    let (read, _) = read(fake, notes)
    #expect(read == .nothing)
    // Stopped within one element (five questions) of the 0.15 s budget, nowhere near the 190 elements.
    #expect(fake.asked <= 20)
    #expect(fake.clock < 0.2)
  }

  /// The wait for a tree is not spent from the budget: after it the read is given its own time again.
  @Test func theWaitIsNotSpentFromTheBudget() {
    let fake = Fake()
    fake.settable = ["AXManualAccessibility"]
    fake.cost = 0.01
    let (read, paused) = read(fake, slack, pause: {
      fake.pass(0.2)
      fake.attributes = [0: ["AXFocusedUIElement": 1], 1: ["AXSelectedText": "after the wait"]]
    })
    #expect(read == .text("after the wait"))
    #expect(paused == 1)
  }

  /// One opening of the window reads once: asked again (the window key, the box focused), it reads only when the
  /// app or its focused element changed since.
  @Test func oneReadPerOpening() {
    let fake = Fake()
    fake.attributes = [0: ["AXFocusedUIElement": 1], 1: ["AXSelectedText": "the dog"], 2: ["AXSelectedText": "the cat"]]
    let reader = reader(fake)
    #expect(reader.read(notes, hidden: false, secureInput: { false }) {} == .text("the dog"))
    let once = fake.asked
    for _ in 0..<3 { #expect(reader.read(notes, hidden: false, onlyIfChanged: true, secureInput: { false }) {} == nil) }
    // Each check asks only what is focused.
    #expect(fake.asked == once + 3)

    fake.attributes[0]?["AXFocusedUIElement"] = 2
    #expect(reader.read(notes, hidden: false, onlyIfChanged: true, secureInput: { false }) {} == .text("the cat"))
    #expect(reader.read(chrome, hidden: false, onlyIfChanged: true, secureInput: { false }) {} == .text("the cat"))
    #expect(reader.read(chrome, hidden: false, onlyIfChanged: true, secureInput: { false }) {} == nil)
    // A new opening reads whatever was read before.
    #expect(reader.read(chrome, hidden: false, secureInput: { false }) {} == .text("the cat"))
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
