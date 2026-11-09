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

/// A window already open follows a change of the app's appearance, as AppearanceModel makes when the dashboard's
/// theme arrives: drawn as a window opened in the new one is, and nothing like it was.
@MainActor
@Suite("Theme follows", .serialized)
struct ThemeFollowsTests {
  private func pixels(_ host: NSView) -> [UInt8] {
    let w = Int(host.bounds.width), h = Int(host.bounds.height)
    guard let space = CGColorSpace(name: CGColorSpace.sRGB),
          let context = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: space,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return [] }
    host.layer?.render(in: context)
    guard let data = context.data else { return [] }
    return Array(UnsafeBufferPointer(start: data.assumingMemoryBound(to: UInt8.self), count: w * h * 4))
  }

  /// The share of pixels that differ by more than a step of rounding.
  private func apart(_ a: [UInt8], _ b: [UInt8]) -> Double {
    guard a.count == b.count, !a.isEmpty else { return 1 }
    var differ = 0
    for i in stride(from: 0, to: a.count, by: 4) where (0..<3).contains(where: { abs(Int(a[i + $0]) - Int(b[i + $0])) > 8 }) {
      differ += 1
    }
    return Double(differ) / Double(a.count / 4)
  }

  /// Opened as the app would open it: no appearance of its own, so the app's shows through.
  private func open<V: View>(_ view: V, _ size: CGSize) -> (NSView, NSWindow) {
    let host = NSHostingView(rootView: view)
    host.frame = CGRect(origin: .zero, size: size)
    let window = NSWindow(contentRect: host.frame, styleMask: .borderless, backing: .buffered, defer: false)
    window.contentView = host
    settle(window)
    return (host, window)
  }

  /// A turn of the run loop and a display pass, as the app's run loop gives a window, not a redraw forced on it.
  private func settle(_ window: NSWindow) {
    RunLoop.main.run(until: Date().addingTimeInterval(0.15))
    window.displayIfNeeded()
    RunLoop.main.run(until: Date().addingTimeInterval(0.05))
  }

  private func follows<V: View>(_ make: () -> V, _ size: CGSize) {
    let app = NSApplication.shared
    let was = app.appearance
    defer { app.appearance = was }
    for (from, to) in [(NSAppearance.Name.aqua, NSAppearance.Name.darkAqua), (.darkAqua, .aqua)] {
      app.appearance = NSAppearance(named: from)
      let (host, window) = open(make(), size)
      let before = pixels(host)
      app.appearance = NSAppearance(named: to)
      settle(window)
      let after = pixels(host)
      let fresh = pixels(open(make(), size).0)
      #expect(apart(after, fresh) < 0.01, "\(V.self) did not redraw in \(to.rawValue)")
      #expect(apart(after, before) > 0.5, "\(V.self) kept its look from \(from.rawValue)")
    }
  }

  @Test func anOpenHomeWindowFollows() {
    follows({ HomeView(model: HomeModel()) }, CGSize(width: HomeView.width, height: HomeView.height))
  }

  @Test func anOpenChatWindowFollows() {
    follows({ () -> ChatView in
      let model = ChatModel()
      model.paired = true
      model.online = true
      model.beside = "Keynote"
      model.show(conversation: "c", title: "Q3", lines: [.you("What still needs numbers?", files: []), .kos("Slides **4** and 7.")])
      return ChatView(model: model)
    }, ChatView.size)
  }
}
