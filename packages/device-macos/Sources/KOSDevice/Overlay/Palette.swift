import AppKit

/// KOS's colours for what it draws over the screen, the design tokens' accent, violet and warn (docs/design.md).
enum Palette {
  static let accent = NSColor(srgbRed: 0x7C / 255, green: 0x9C / 255, blue: 0xFF / 255, alpha: 1)
  static let violet = NSColor(srgbRed: 0xA5 / 255, green: 0x7C / 255, blue: 0xFF / 255, alpha: 1)
  static let amber = NSColor(srgbRed: 0xE6 / 255, green: 0xB8 / 255, blue: 0x4D / 255, alpha: 1)
}
