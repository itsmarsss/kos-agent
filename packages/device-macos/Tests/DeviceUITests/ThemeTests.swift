import AppKit
import DeviceCore
import SwiftUI
import Testing

@testable import DeviceUI

/// The tokens are the dark palette's or the light one's by the appearance they are drawn in.
/// On the main actor: SwiftUI resolves a colour AppKit gives it there.
@MainActor
@Suite("Theme")
struct ThemeTests {
  private func hex(_ colour: Color, _ name: NSAppearance.Name) -> UInt32 {
    var rgb: UInt32 = 0
    NSAppearance(named: name)?.performAsCurrentDrawingAppearance {
      let c = NSColor(colour).usingColorSpace(.sRGB) ?? .clear
      rgb = UInt32((c.redComponent * 255).rounded()) << 16 | UInt32((c.greenComponent * 255).rounded()) << 8
        | UInt32((c.blueComponent * 255).rounded())
    }
    return rgb
  }

  private func hex(_ colour: Color, _ scheme: ColorScheme) -> UInt32 {
    var environment = EnvironmentValues()
    environment.colorScheme = scheme
    let c = colour.resolve(in: environment)
    return UInt32((c.red * 255).rounded()) << 16 | UInt32((c.green * 255).rounded()) << 8 | UInt32((c.blue * 255).rounded())
  }

  private func near(_ a: UInt32, _ b: UInt32) -> Bool {
    [16, 8, 0].allSatisfy { abs(Int((a >> $0) & 0xFF) - Int((b >> $0) & 0xFF)) <= 1 }
  }

  @Test func aTokenIsTheDarkPalettesInDarkAndTheLightOnesInLight() {
    #expect(hex(Theme.bg, .darkAqua) == 0x0C0E12)
    #expect(hex(Theme.bg, .aqua) == 0xF4F5F8)
    #expect(hex(Theme.accent, .darkAqua) == 0x7C9CFF)
    #expect(hex(Theme.accent, .aqua) == 0x3558D6)
    #expect(hex(Theme.text, .dark) == 0xE7EBF3)
    #expect(hex(Theme.text, .light) == 0x161A22)
  }

  @Test func aBlendFollowsBothOfItsColours() {
    let tint = Theme.accent.opacity(0.5).blended(over: Theme.panel)
    // Half the accent over the panel, in each palette, to a step of rounding.
    #expect(near(hex(tint, .dark), 0x47598E))
    #expect(near(hex(tint, .light), 0x9AACEB))
    #expect(near(hex(tint, .aqua), 0x9AACEB))
  }

  @Test func theHighContrastAppearancesCountAsTheirOwnShade() {
    #expect(NSAppearance(named: .accessibilityHighContrastDarkAqua)?.isDark == true)
    #expect(NSAppearance(named: .accessibilityHighContrastAqua)?.isDark == false)
    #expect(NSAppearance(named: .aqua)?.isDark == false)
  }

  /// What AppearanceModel sets the app in: light and dark their own, system none, so macOS's own shows through.
  @Test func eachThemeSetsTheAppearanceItNames() {
    #expect(ThemeMode.light.appearanceName == .aqua)
    #expect(ThemeMode.dark.appearanceName == .darkAqua)
    #expect(ThemeMode.system.appearanceName == nil)
    #expect(ThemeChoice.dashboard.mode(sent: .dark).appearanceName.flatMap(NSAppearance.init(named:))?.isDark == true)
  }
}
