import Foundation

/// One step of typing: a run of characters sent as text, or a key pressed for real.
public enum TypingStep: Equatable, Sendable {
  case text(String)
  case key(KeyCombo)
}

/// Text as the steps that type it.
///
/// Characters go as unicode strings, which macOS accepts whatever the
/// keyboard layout, a few at a time so the owner sees it being typed. A
/// line break or a tab is a key press, because apps treat Return and Tab as
/// keys (sending a message, moving a field), not as characters.
public enum Typing {
  /// macOS takes at most 20 UTF-16 units in one keyboard event; fewer reads as typing.
  public static let chunkUnits = 8

  public static func steps(for text: String) -> [TypingStep] {
    var steps: [TypingStep] = []
    var run = ""
    func flush() {
      if !run.isEmpty { steps.append(.text(run)) }
      run = ""
    }
    for character in text {
      switch character {
      case "\n", "\r\n", "\r":
        flush()
        steps.append(.key(KeyCombo(code: 36)))
      case "\t":
        flush()
        steps.append(.key(KeyCombo(code: 48)))
      default:
        if run.utf16.count + String(character).utf16.count > chunkUnits { flush() }
        run.append(character)
      }
    }
    flush()
    return steps
  }
}
