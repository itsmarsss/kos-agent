import Foundation

/// Modifier keys, with the CGEventFlags bits each one sets, so the app can
/// post them without DeviceCore knowing CoreGraphics.
public struct Modifiers: OptionSet, Hashable, Sendable {
  public let rawValue: UInt64

  public init(rawValue: UInt64) {
    self.rawValue = rawValue
  }

  public static let shift = Modifiers(rawValue: 1 << 17)
  public static let control = Modifiers(rawValue: 1 << 18)
  public static let option = Modifiers(rawValue: 1 << 19)
  public static let command = Modifiers(rawValue: 1 << 20)
  /// Set by the hardware on arrows and keypad keys; apps read it.
  public static let numericPad = Modifiers(rawValue: 1 << 21)
  public static let function = Modifiers(rawValue: 1 << 23)

  /// The modifier keys a person would press, in the order they go down, with their key codes.
  public static let pressable: [(Modifiers, UInt16)] = [
    (.command, 55), (.shift, 56), (.option, 58), (.control, 59), (.function, 63),
  ]
}

/// One key and the modifiers held with it, read from `cmd+shift+t`.
public struct KeyCombo: Equatable, Sendable {
  /// A virtual key code (the US ANSI layout's, as macOS numbers them).
  public let code: UInt16
  /// The modifiers to press and release around the key.
  public let modifiers: Modifiers
  /// Flags the hardware sets on this key by itself (arrows carry fn and keypad).
  public let implied: Modifiers

  public init(code: UInt16, modifiers: Modifiers = [], implied: Modifiers = []) {
    self.code = code
    self.modifiers = modifiers
    self.implied = implied
  }

  /// Reads one combination. The last part is the key; the parts before it are modifiers.
  public static func parse(_ text: String) throws -> KeyCombo {
    let trimmed = text.trimmingCharacters(in: .whitespaces)
    guard !trimmed.isEmpty else { throw DeviceError.badRequest("No keys given.") }
    var parts: [String]
    if trimmed == "+" {
      parts = ["+"]
    } else if trimmed.hasSuffix("++") {
      parts = trimmed.dropLast(2).split(separator: "+").map(String.init) + ["+"]
    } else {
      parts = trimmed.split(separator: "+", omittingEmptySubsequences: false).map(String.init)
    }
    parts = parts.map { $0.trimmingCharacters(in: .whitespaces) }
    guard !parts.contains(where: \.isEmpty), let last = parts.popLast() else {
      throw DeviceError.badRequest("\(text) is not a key combination. Write it like cmd+shift+t.")
    }
    var modifiers: Modifiers = []
    for part in parts {
      guard let modifier = modifier(named: part) else {
        throw DeviceError.badRequest("\(part) is not a modifier. Use cmd, shift, ctrl, alt or fn.")
      }
      modifiers.insert(modifier)
    }
    if let (code, shifted, implied) = key(named: last) {
      return KeyCombo(code: code, modifiers: shifted ? modifiers.union(.shift) : modifiers, implied: implied)
    }
    // A modifier pressed by itself, such as shift.
    if let modifier = modifier(named: last), let code = Modifiers.pressable.first(where: { $0.0 == modifier })?.1 {
      return KeyCombo(code: code, modifiers: modifiers)
    }
    throw DeviceError.badRequest("\(last) is not a key KOS Device knows.")
  }

  /// Modifiers held through a click, named the way combinations name them.
  public static func modifiers(named names: [String]) throws -> Modifiers {
    try names.reduce(into: Modifiers()) { held, name in
      guard let modifier = modifier(named: name.trimmingCharacters(in: .whitespaces)) else {
        throw DeviceError.badRequest("\(name) is not a modifier. Use cmd, shift, ctrl, alt or fn.")
      }
      held.insert(modifier)
    }
  }

  private static func normalized(_ name: String) -> String {
    var n = name.lowercased().replacingOccurrences(of: "_", with: "")
    // xdotool's left and right variants (Control_L, Super_R) are the same key here.
    for side in ["l", "r"] where n.count > 2 && n.hasSuffix(side) && modifierNames[String(n.dropLast())] != nil {
      n.removeLast()
    }
    return n
  }

  private static func modifier(named name: String) -> Modifiers? {
    modifierNames[normalized(name)]
  }

  /// A key's code, whether it needs shift (for `?` or `+`), and the flags it implies.
  private static func key(named name: String) -> (UInt16, Bool, Modifiers)? {
    if name.count == 1, let c = name.lowercased().first {
      if let code = characterCodes[c] { return (code, false, []) }
      if let base = shiftedCharacters[c], let code = characterCodes[base] { return (code, true, []) }
    }
    let n = normalized(name)
    if let code = namedCodes[n] { return (code, false, implied(for: code)) }
    if n == "plus" { return (24, true, []) }
    if n.hasPrefix("f"), let number = Int(n.dropFirst()), let code = functionCodes[number] {
      return (code, false, .function)
    }
    return nil
  }

  private static func implied(for code: UInt16) -> Modifiers {
    switch code {
    case 123...126: return [.function, .numericPad]
    case 76: return .numericPad
    case 114...121: return .function
    default: return []
    }
  }

  private static let modifierNames: [String: Modifiers] = [
    "cmd": .command, "command": .command, "meta": .command, "super": .command, "win": .command, "windows": .command,
    "shift": .shift,
    "ctrl": .control, "control": .control,
    "alt": .option, "option": .option, "opt": .option,
    "fn": .function, "function": .function,
  ]

  private static let characterCodes: [Character: UInt16] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26,
    "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35,
    "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44,
    "n": 45, "m": 46, ".": 47, "`": 50, " ": 49,
  ]

  /// Characters typed with shift on a US keyboard, and the key under them.
  private static let shiftedCharacters: [Character: Character] = [
    "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
    "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'", "<": ",", ">": ".", "?": "/", "~": "`",
  ]

  private static let namedCodes: [String: UInt16] = [
    "return": 36, "enter": 36, "ret": 36, "kpenter": 76,
    "tab": 48, "space": 49, "spacebar": 49,
    "escape": 53, "esc": 53,
    "backspace": 51,
    "delete": 117, "del": 117, "forwarddelete": 117,
    "capslock": 57, "help": 114, "insert": 114,
    "home": 115, "end": 119,
    "pageup": 116, "prior": 116, "pagedown": 121, "next": 121,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "arrowleft": 123, "arrowright": 124, "arrowdown": 125, "arrowup": 126,
    "minus": 27, "equal": 24, "equals": 24, "bracketleft": 33, "bracketright": 30,
    "semicolon": 41, "apostrophe": 39, "quote": 39, "grave": 50, "backslash": 42,
    "comma": 43, "period": 47, "slash": 44,
    "volumeup": 72, "volumedown": 73, "mute": 74,
  ]

  private static let functionCodes: [Int: UInt16] = [
    1: 122, 2: 120, 3: 99, 4: 118, 5: 96, 6: 97, 7: 98, 8: 100, 9: 101, 10: 109,
    11: 103, 12: 111, 13: 105, 14: 107, 15: 113, 16: 106, 17: 64, 18: 79, 19: 80, 20: 90,
  ]
}
