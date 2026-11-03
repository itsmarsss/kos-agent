import AppKit
import SwiftUI

/// KOS's design tokens, so KOS for Mac reads as KOS (docs/design.md).
///
/// The values are packages/shared/src/design.ts, declared here as the
/// dashboard's styles.css and the extension's kos.css declare them, and held
/// to it by design.test.ts. KOS for Mac's windows are always dark, like the
/// border and cursor it draws over the screen.
public enum Theme {
  public static let bg = Color(hex: 0x0C0E12)
  public static let panel = Color(hex: 0x12151C)
  public static let panel2 = Color(hex: 0x181C26)
  public static let line = Color(hex: 0x262B36)
  public static let lineStrong = Color(hex: 0x3A4150)
  public static let text = Color(hex: 0xE7EBF3)
  public static let muted = Color(hex: 0x8B93A7)
  public static let faint = Color(hex: 0x5C6578)
  public static let accent = Color(hex: 0x7C9CFF)
  /// The accent under the pointer.
  public static let accentLit = Color(hex: 0x9BB4FF)
  public static let violet = Color(hex: 0xA57CFF)
  public static let ok = Color(hex: 0x3ECF8E)
  public static let warn = Color(hex: 0xE6B84D)
  public static let danger = Color(hex: 0xF07178)
  /// Text on an accent surface.
  public static let onAccent = Color(hex: 0x0B0E14)

  /// Corners: a keycap or code, a control, a card, a sheet.
  public static let radiusXs: CGFloat = 4
  public static let radiusSm: CGFloat = 7
  public static let radiusMd: CGFloat = 10
  public static let radiusLg: CGFloat = 14
  public static let gutter: CGFloat = 20

  /// The one spring anything that moves into place uses, the web's spring too.
  public static let spring = Animation.interpolatingSpring(mass: 0.9, stiffness: 420, damping: 38)
  /// How a control answers the pointer coming over it, and a press.
  public static let hover = Animation.easeOut(duration: 0.14)
  public static let press = Animation.easeOut(duration: 0.08)

  /// A colour laid under what it marks (a tile, a lit chip, a pill), and the edge drawn round a lit one: the web's 14% and 45%.
  public static let tint: Double = 0.14
  public static let edge: Double = 0.45
}

/// KOS's sizes of type, by what each sets (docs/design.md, Type): the chat's
/// are the dashboard's, the windows' the extension's.
public enum KOSType: CGFloat {
  /// A window's title: KOS for Mac, Settings, the prompt's question.
  case title = 17
  /// A chat's words, the owner's and KOS's, and the box they are typed in.
  case body = 15
  /// A table's cells.
  case table = 14
  /// A row's title; code blocks and table heads.
  case dense = 13
  /// A button, a session's task, an app's name over its window.
  case control = 12.5
  /// Chips, hints, the chat's name, a field's words.
  case detail = 12
  /// A row's line of detail under its title.
  case small = 11.5
  /// A pill, a note in a chat, a time.
  case tiny = 11
  /// A section's label over its cards.
  case label = 10.5
}

extension Font {
  /// The system face at one of KOS's sizes.
  public static func kos(_ size: KOSType, _ weight: Font.Weight = .regular, design: Font.Design = .default) -> Font {
    .system(size: size.rawValue, weight: weight, design: design)
  }
}

extension Color {
  init(hex: UInt32, opacity: Double = 1) {
    self.init(
      .sRGB,
      red: Double((hex >> 16) & 0xFF) / 255,
      green: Double((hex >> 8) & 0xFF) / 255,
      blue: Double(hex & 0xFF) / 255,
      opacity: opacity)
  }
}

extension Color {
  /// This colour, at its opacity, laid over a solid one: the tint the dashboard mixes with color-mix.
  func blended(over base: Color) -> Color {
    let top = NSColor(self).usingColorSpace(.sRGB) ?? .black
    let under = NSColor(base).usingColorSpace(.sRGB) ?? .black
    let a = top.alphaComponent
    return Color(
      .sRGB,
      red: Double(top.redComponent * a + under.redComponent * (1 - a)),
      green: Double(top.greenComponent * a + under.greenComponent * (1 - a)),
      blue: Double(top.blueComponent * a + under.blueComponent * (1 - a)))
  }
}
