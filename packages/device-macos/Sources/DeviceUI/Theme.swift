import SwiftUI

/// The dashboard's colours and measures, so KOS Device reads as KOS.
///
/// The same tokens as packages/ui/src/styles.css, dark theme: KOS Device's
/// windows are always dark, like the dashboard's default and like the
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

  public static let radius: CGFloat = 10
  public static let gutter: CGFloat = 20
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
