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
