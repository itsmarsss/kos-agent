import Testing
@testable import DeviceCore

@Suite("Key combinations")
struct KeyComboTests {
  @Test func readsModifiersAndAKey() throws {
    let combo = try KeyCombo.parse("cmd+shift+t")
    #expect(combo.code == 17)
    #expect(combo.modifiers == [.command, .shift])
  }

  @Test(arguments: [
    ("cmd+c", UInt16(8)), ("command+c", 8), ("meta+c", 8), ("super+c", 8), ("win+c", 8),
  ])
  func everyNameForCommand(text: String, code: UInt16) throws {
    let combo = try KeyCombo.parse(text)
    #expect(combo.code == code)
    #expect(combo.modifiers == .command)
  }

  @Test func readsXdotoolSpellings() throws {
    #expect(try KeyCombo.parse("Return").code == 36)
    #expect(try KeyCombo.parse("BackSpace").code == 51)
    #expect(try KeyCombo.parse("Page_Down").code == 121)
    #expect(try KeyCombo.parse("KP_Enter").code == 76)
    #expect(try KeyCombo.parse("Control_L+a").modifiers == .control)
    #expect(try KeyCombo.parse("Super_R+space").modifiers == .command)
    #expect(try KeyCombo.parse("alt+Tab") == KeyCombo(code: 48, modifiers: .option))
  }

  @Test func casesAndSpacesDoNotMatter() throws {
    #expect(try KeyCombo.parse(" Ctrl + A ") == KeyCombo(code: 0, modifiers: .control))
    #expect(try KeyCombo.parse("ESC").code == 53)
  }

  @Test func deleteIsForwardAndBackspaceIsBack() throws {
    #expect(try KeyCombo.parse("delete").code == 117)
    #expect(try KeyCombo.parse("backspace").code == 51)
  }

  @Test func arrowsCarryTheFlagsHardwareSets() throws {
    let up = try KeyCombo.parse("up")
    #expect(up.code == 126)
    #expect(up.implied == [.function, .numericPad])
    #expect(try KeyCombo.parse("f5") == KeyCombo(code: 96, implied: .function))
    #expect(try KeyCombo.parse("F12").code == 111)
    #expect(try KeyCombo.parse("pageup").implied == .function)
    #expect(try KeyCombo.parse("a").implied == [])
  }

  @Test func punctuationByItself() throws {
    #expect(try KeyCombo.parse("cmd+-") == KeyCombo(code: 27, modifiers: .command))
    #expect(try KeyCombo.parse("cmd+=").code == 24)
    #expect(try KeyCombo.parse("cmd+[").code == 33)
    #expect(try KeyCombo.parse("cmd+/").code == 44)
    #expect(try KeyCombo.parse("cmd+,").code == 43)
  }

  @Test func shiftedCharactersAddShift() throws {
    #expect(try KeyCombo.parse("?") == KeyCombo(code: 44, modifiers: .shift))
    #expect(try KeyCombo.parse("cmd+?") == KeyCombo(code: 44, modifiers: [.command, .shift]))
    #expect(try KeyCombo.parse("cmd++") == KeyCombo(code: 24, modifiers: [.command, .shift]))
    #expect(try KeyCombo.parse("+") == KeyCombo(code: 24, modifiers: .shift))
    #expect(try KeyCombo.parse("cmd+plus") == KeyCombo(code: 24, modifiers: [.command, .shift]))
  }

  @Test func anUppercaseLetterIsTheLetter() throws {
    // cmd+A means select all, not cmd+shift+a.
    #expect(try KeyCombo.parse("cmd+A") == KeyCombo(code: 0, modifiers: .command))
  }

  @Test func aModifierByItselfIsItsKey() throws {
    #expect(try KeyCombo.parse("shift") == KeyCombo(code: 56))
    #expect(try KeyCombo.parse("cmd") == KeyCombo(code: 55))
    #expect(try KeyCombo.parse("fn") == KeyCombo(code: 63))
  }

  @Test(arguments: ["", "cmd+", "+cmd+x", "hyper+x", "cmd+nosuchkey", "f21"])
  func refusesWhatIsNotACombination(text: String) {
    #expect(throws: DeviceError.self) { try KeyCombo.parse(text) }
  }

  @Test func modifierFlagsAreCoreGraphicsBits() {
    #expect(Modifiers.shift.rawValue == 0x20000)
    #expect(Modifiers.control.rawValue == 0x40000)
    #expect(Modifiers.option.rawValue == 0x80000)
    #expect(Modifiers.command.rawValue == 0x100000)
    #expect(Modifiers.numericPad.rawValue == 0x200000)
    #expect(Modifiers.function.rawValue == 0x800000)
  }
}

@Suite("Typing")
struct TypingTests {
  @Test func shortTextIsOneStep() {
    #expect(Typing.steps(for: "hello") == [.text("hello")])
  }

  @Test func longTextIsTypedAFewCharactersAtATime() {
    let steps = Typing.steps(for: "abcdefghijkl")
    #expect(steps == [.text("abcdefgh"), .text("ijkl")])
  }

  @Test func lineBreaksAndTabsArePressed() {
    let steps = Typing.steps(for: "a\nb\tc\r\nd")
    #expect(steps == [
      .text("a"), .key(KeyCombo(code: 36)), .text("b"), .key(KeyCombo(code: 48)), .text("c"), .key(KeyCombo(code: 36)), .text("d"),
    ])
  }

  @Test func neverSplitsACharacter() {
    // Each flag is four UTF-16 units; two fit in a chunk, a third does not.
    let steps = Typing.steps(for: "🇨🇦🇨🇦🇨🇦")
    #expect(steps == [.text("🇨🇦🇨🇦"), .text("🇨🇦")])
    for case .text(let run) in steps { #expect(run.utf16.count <= 20) }
  }

  @Test func nothingTypesNothing() {
    #expect(Typing.steps(for: "") == [])
  }
}
