import AppKit
import SwiftUI
import Testing

@testable import DeviceUI

/// Every window state lays out at a sane size, drawn offscreen as the app would.
///
/// With KOS_SNAPSHOT_DIR set, each one is also written there as a PNG, so a
/// change to the look can be seen without pairing a Mac or asking for a
/// session.
@MainActor
@Suite("Windows render")
struct RenderTests {
  private func render<V: View>(_ name: String, _ view: V) throws -> CGSize {
    let host = NSHostingView(rootView: view)
    let size = host.fittingSize
    host.frame = CGRect(origin: .zero, size: size)
    let window = NSWindow(contentRect: host.frame, styleMask: .borderless, backing: .buffered, defer: false)
    window.contentView = host
    host.layoutSubtreeIfNeeded()
    if let dir = ProcessInfo.processInfo.environment["KOS_SNAPSHOT_DIR"] {
      let rep = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
      host.cacheDisplay(in: host.bounds, to: rep)
      let png = try #require(rep.representation(using: .png, properties: [:]))
      try png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
    }
    return size
  }

  private func home(_ configure: (HomeModel) -> Void) -> HomeModel {
    let model = HomeModel()
    model.hidden = [
      AppEntry(id: "com.1password.1password", name: "1Password", icon: nil),
      AppEntry(id: "com.bitwarden.desktop", name: "Bitwarden", icon: nil, installed: false),
      AppEntry(id: "com.dashlane.Dashlane", name: "Dashlane", icon: nil, installed: false),
      AppEntry(id: "com.apple.keychainaccess", name: "Keychain Access", icon: nil),
    ]
    configure(model)
    return model
  }

  @Test func homeWhenNotPaired() throws {
    let model = home {
      $0.address = "http://127.0.0.1:4417"
      $0.code = "RFMA-DGDT"
      $0.name = "Studio MacBook"
      $0.note = "Check this is your KOS, then press Pair."
      $0.devicesPage = URL(string: "http://127.0.0.1:4417/#/settings/devices")
    }
    let size = try render("home-unpaired", HomeView(model: model))
    #expect(size.width == 460)
    #expect(size.height > 400 && size.height < 900)
  }

  @Test func homeWhenConnectedAndInUse() throws {
    let model = home {
      $0.link = .connected
      $0.host = "http://127.0.0.1:4417"
      $0.deviceName = "Studio MacBook"
      $0.screenGranted = true
      $0.inputGranted = true
      $0.dashboard = URL(string: "http://127.0.0.1:4417")
      $0.session = SessionSummary(
        task: "Export the deck from Keynote as a PDF", requester: "Design", chat: URL(string: "http://127.0.0.1:4417/#/chats/c1"),
        until: Date().addingTimeInterval(900), paused: false)
    }
    let size = try render("home-in-use", HomeView(model: model))
    #expect(size.height < 900)
  }

  @Test func homeWhenOfflineAndMissingAGrant() throws {
    let model = home {
      $0.link = .offline("KOS is not answering.")
      $0.host = "https://kos.example.ts.net"
      $0.deviceName = "Studio MacBook"
      $0.inputGranted = true
      $0.asked = [.screen]
      $0.askFirst = false
    }
    _ = try render("home-offline", HomeView(model: model))
  }

  @Test func homeWithThePermissionsDrawerOpen() throws {
    let model = home {
      $0.link = .connected
      $0.host = "127.0.0.1:4317"
      $0.dashboard = URL(string: "http://127.0.0.1:4317")
      $0.deviceName = "Studio MacBook"
      $0.screenGranted = true
      $0.inputGranted = true
    }
    _ = try render("home-drawer", HomeView(model: model, permissionsOpen: true))
  }

  @Test func settingsPage() throws {
    let model = home {
      $0.link = .connected
      $0.page = .settings
      $0.longestMinutes = 120
      $0.openAtLogin = .needsApproval
    }
    _ = try render("settings", HomeView(model: model))
  }

  @Test func consentWithALengthOfTheOwnersOwn() throws {
    let model = ConsentModel(task: "Tidy the desktop into folders", requester: "Home", offered: [5, 15, 30, 60, 120], longest: 240, timeout: 60)
    model.custom = true
    model.minutes = 45
    _ = try render("consent-custom", ConsentView(model: model))
  }

  @Test func consentWithAWindowPicker() throws {
    let model = ConsentModel(task: "Export the cover frame", requester: "Design", offered: [5, 15], longest: 60, timeout: 60)
    model.targets = [
      TargetChoice(id: TargetChoice.screen, title: "Entire screen", app: nil, icon: nil),
      TargetChoice(id: "11", title: "Cover", app: "Figma", icon: nil),
      TargetChoice(id: "12", title: "Inbox", app: "Mail", icon: nil),
    ]
    model.target = "11"
    model.suggested = "Figma"
    let size = try render("consent-picker", ConsentView(model: model))
    #expect(size.width == 420)
  }

  @Test func disconnectedByTheOwner() throws {
    let model = home {
      $0.link = .disconnected
      $0.host = "127.0.0.1:4317"
      $0.screenGranted = true
      $0.inputGranted = true
    }
    _ = try render("home-disconnected", HomeView(model: model))
  }

  @Test func appPicker() throws {
    let apps = [
      AppEntry(id: "com.apple.Safari", name: "Safari", icon: nil, running: true),
      AppEntry(id: "com.apple.mail", name: "Mail", icon: nil, running: true),
      AppEntry(id: "com.apple.Notes", name: "Notes", icon: nil),
      AppEntry(id: "com.figma.Desktop", name: "Figma", icon: nil),
    ]
    let size = try render("picker", AppPicker(apps: apps) { _ in })
    #expect(size.width == 290)
  }

  @Test func sessionBar() throws {
    let model = SessionBarModel(task: "Export the deck from Keynote as a PDF", until: Date().addingTimeInterval(12 * 60))
    _ = try render("bar", SessionBar(model: model))
    model.paused = true
    let size = try render("bar-paused", SessionBar(model: model))
    #expect(size.height == SessionBar.height + 28)
  }

  @Test func consent() throws {
    let model = ConsentModel(
      task: "Open the Figma file from yesterday and export the cover frame", requester: "Design",
      chat: URL(string: "http://127.0.0.1:4417/#/chats/c1"), offered: [5, 15], timeout: 60)
    model.remaining = 44
    let size = try render("consent", ConsentView(model: model))
    #expect(size.width == 380)
  }
}
