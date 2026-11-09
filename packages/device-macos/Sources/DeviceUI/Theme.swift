import AppKit
import DeviceCore
import SwiftUI

/// KOS's design tokens, so KOS for Mac reads as KOS (docs/design.md).
///
/// Each colour is the dark palette's or the light one's, by the appearance it
/// is drawn in: the app sets that in one place (AppearanceModel), from the
/// owner's choice and the dashboard's theme. The dark values are
/// packages/shared/src/design.ts, as the dashboard's styles.css and the
/// extension's kos.css declare them in :root, and held to it by
/// design.test.ts; the light ones are styles.css's :root[data-theme="light"].
public enum Theme {
  /// The dashboard's :root.
  enum Dark {
    static let bg = Color(hex: 0x0C0E12)
    static let panel = Color(hex: 0x12151C)
    static let panel2 = Color(hex: 0x181C26)
    static let line = Color(hex: 0x262B36)
    static let lineStrong = Color(hex: 0x3A4150)
    static let text = Color(hex: 0xE7EBF3)
    static let muted = Color(hex: 0x8B93A7)
    static let faint = Color(hex: 0x5C6578)
    static let accent = Color(hex: 0x7C9CFF)
    static let accentLit = Color(hex: 0x9BB4FF)
    static let violet = Color(hex: 0xA57CFF)
    static let ok = Color(hex: 0x3ECF8E)
    static let warn = Color(hex: 0xE6B84D)
    static let danger = Color(hex: 0xF07178)
    static let onAccent = Color(hex: 0x0B0E14)
  }

  /// The dashboard's :root[data-theme="light"]: the same roles, chosen for paper.
  enum Light {
    static let bg = Color(hex: 0xF4F5F8)
    static let panel = Color(hex: 0xFFFFFF)
    static let panel2 = Color(hex: 0xECEEF3)
    static let line = Color(hex: 0xDDE1E8)
    static let lineStrong = Color(hex: 0xBFC6D3)
    static let text = Color(hex: 0x161A22)
    static let muted = Color(hex: 0x58607A)
    static let faint = Color(hex: 0x8089A0)
    static let accent = Color(hex: 0x3558D6)
    static let accentLit = Color(hex: 0x2A47B8)
    static let violet = Color(hex: 0x7B4FD6)
    static let ok = Color(hex: 0x0F6E45)
    static let warn = Color(hex: 0x7D5400)
    static let danger = Color(hex: 0xCF3B47)
    static let onAccent = Color(hex: 0xFFFFFF)
  }

  public static let bg = Color(dark: Dark.bg, light: Light.bg)
  public static let panel = Color(dark: Dark.panel, light: Light.panel)
  public static let panel2 = Color(dark: Dark.panel2, light: Light.panel2)
  public static let line = Color(dark: Dark.line, light: Light.line)
  public static let lineStrong = Color(dark: Dark.lineStrong, light: Light.lineStrong)
  public static let text = Color(dark: Dark.text, light: Light.text)
  public static let muted = Color(dark: Dark.muted, light: Light.muted)
  public static let faint = Color(dark: Dark.faint, light: Light.faint)
  public static let accent = Color(dark: Dark.accent, light: Light.accent)
  /// The accent under the pointer.
  public static let accentLit = Color(dark: Dark.accentLit, light: Light.accentLit)
  public static let violet = Color(dark: Dark.violet, light: Light.violet)
  public static let ok = Color(dark: Dark.ok, light: Light.ok)
  public static let warn = Color(dark: Dark.warn, light: Light.warn)
  public static let danger = Color(dark: Dark.danger, light: Light.danger)
  /// Text on an accent surface.
  public static let onAccent = Color(dark: Dark.onAccent, light: Light.onAccent)

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
  /// A pill, a note in a chat, a time, a section's label over its cards (the kit's .label).
  case tiny = 11
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
  /// One colour in a dark appearance, another in a light one, resolved wherever it is drawn.
  init(dark: Color, light: Color) {
    let dark = NSColor(dark), light = NSColor(light)
    self.init(nsColor: NSColor(name: nil) { $0.isDark ? dark : light })
  }

  /// This colour, at its opacity, laid over a solid one: the tint the dashboard mixes with color-mix.
  /// Mixed again in each appearance, so a tint of two tokens follows them both.
  func blended(over base: Color) -> Color {
    let top = NSColor(self), under = NSColor(base)
    // Read in the appearance asked for: the tokens under them are dynamic colours, resolved in the current one.
    return Color(nsColor: NSColor(name: nil) { appearance in
      var mixed = NSColor.black
      appearance.performAsCurrentDrawingAppearance {
        let t = top.usingColorSpace(.sRGB) ?? .black, u = under.usingColorSpace(.sRGB) ?? .black
        let a = t.alphaComponent
        mixed = NSColor(
          srgbRed: t.redComponent * a + u.redComponent * (1 - a), green: t.greenComponent * a + u.greenComponent * (1 - a),
          blue: t.blueComponent * a + u.blueComponent * (1 - a), alpha: 1)
      }
      return mixed
    })
  }
}

extension NSAppearance {
  /// Dark or a dark variant of it (the high-contrast one too).
  public var isDark: Bool {
    bestMatch(from: [.aqua, .darkAqua, .accessibilityHighContrastAqua, .accessibilityHighContrastDarkAqua])
      .map { $0 == .darkAqua || $0 == .accessibilityHighContrastDarkAqua } ?? false
  }
}

extension ThemeMode {
  /// The appearance the app is set in for this theme: none for `system`, so AppKit follows macOS's own as it changes.
  public var appearanceName: NSAppearance.Name? {
    switch self {
    case .light: .aqua
    case .dark: .darkAqua
    case .system: nil
    }
  }
}
