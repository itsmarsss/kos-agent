import AppKit

/// KOS's colours, the same as the dashboard's, so the border reads as KOS at a glance.
enum Palette {
  static let accent = NSColor(srgbRed: 0x7C / 255, green: 0x9C / 255, blue: 0xFF / 255, alpha: 1)
  static let violet = NSColor(srgbRed: 0xA5 / 255, green: 0x7C / 255, blue: 0xFF / 255, alpha: 1)
  static let amber = NSColor(srgbRed: 0xE6 / 255, green: 0xB8 / 255, blue: 0x4D / 255, alpha: 1)
  static let stop = NSColor(srgbRed: 0xF2 / 255, green: 0x6D / 255, blue: 0x6D / 255, alpha: 1)
}
