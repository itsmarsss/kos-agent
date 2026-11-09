import AppKit

/// KOS's colours for what it draws over the screen, the design tokens' accent, violet and warn (docs/design.md).
///
/// The dark palette's in either theme: they glow over whatever is on the
/// screen, light or dark, where the light palette's deeper ones would sink into a dark page.
enum Palette {
  static let accent = NSColor(srgbRed: 0x7C / 255, green: 0x9C / 255, blue: 0xFF / 255, alpha: 1)
  static let violet = NSColor(srgbRed: 0xA5 / 255, green: 0x7C / 255, blue: 0xFF / 255, alpha: 1)
  static let amber = NSColor(srgbRed: 0xE6 / 255, green: 0xB8 / 255, blue: 0x4D / 255, alpha: 1)
  /// Words on the accent: the dark palette's on-accent, as the accent is the dark palette's.
  static let ink = NSColor(srgbRed: 0x0B / 255, green: 0x0E / 255, blue: 0x14 / 255, alpha: 1)
}
