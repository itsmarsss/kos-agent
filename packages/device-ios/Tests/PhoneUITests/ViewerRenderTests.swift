import AppKit
import DeviceCore
import DeviceKit
import SwiftUI
import Testing
import WebKit

@testable import PhoneCore
@testable import PhoneUI

/// The artifact viewer, the box with files in it, and the chats with the artifacts to read. An artifact is drawn by
/// the viewer's own web view (ArtifactFrame, its script and policy), offscreen, and its picture set where the view
/// would be: the harness draws what the phone would. With KOS_ARTIFACT_FIXTURES pointing at what
/// scripts/artifact-fixtures.mjs writes, the doc, deck and sheet are KOS's own, built from the dashboard's runtimes;
/// without it, a small page stands in for each, so the viewer is still drawn.
extension RenderTests {
  /// One artifact's documents in each theme, as KOS sends them.
  struct Fixture: Decodable {
    let id: String
    let title: String
    let kind: String
    let documents: [String: String]
    let themes: ArtifactOpened.Themes

    func artifact(dark: Bool) -> ArtifactShelf.Artifact {
      ArtifactShelf.Artifact(
        id: id, title: title, kind: kind, place: .project("Garden"), updated: Date().addingTimeInterval(-2 * 3600),
        document: documents[dark ? "dark" : "light"] ?? "", themes: themes, dark: dark)
    }
  }

  static func fixture(_ kind: String) throws -> Fixture {
    if let dir = ProcessInfo.processInfo.environment["KOS_ARTIFACT_FIXTURES"] {
      return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: dir).appendingPathComponent("\(kind).json")))
    }
    let page = { (bg: String, ink: String) in
      let inner = "<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\"><style>body{margin:24px;font:15px -apple-system;background:\(bg);color:\(ink)}</style></head><body><h1>\(kind)</h1><p>A stand-in for KOS's own \(kind).</p></body></html>"
      let attr = inner.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "\"", with: "&quot;")
      return "<!doctype html><html><head><style>html,body{margin:0;height:100%}iframe{display:block;width:100%;height:100%;border:0}</style></head><body><iframe sandbox=\"allow-scripts\" srcdoc=\"\(attr)\"></iframe></body></html>"
    }
    return Fixture(
      id: "garden-\(kind)", title: "Garden \(kind)", kind: kind, documents: ["light": page("#fff", "#141d29"), "dark": page("#0f141b", "#e6edf5")],
      themes: .init(light: ":root{}", dark: ":root{}"))
  }

  /// What the viewer's web view draws of an artifact, at the size it has in the viewer, `steps` slides on for a deck.
  func picture(_ artifact: ArtifactShelf.Artifact, size: CGSize, steps: Int = 0) async throws -> NSImage {
    let deck = DeckRemote()
    let frame = ArtifactFrame(artifact: artifact, dark: artifact.dark, read: { _, _, answer in answer(.failure(.init("not in a render"))) }, open: { _ in }, openLink: { _ in }, deck: deck)
    let coordinator = ArtifactFrame.Coordinator(frame)
    let view = frame.makeView(coordinator)
    view.frame = CGRect(origin: .zero, size: size)
    // In a window of its own, as a phone's is, never ordered onto the screen.
    let window = NSWindow(contentRect: CGRect(origin: CGPoint(x: -10_000, y: -10_000), size: size), styleMask: .borderless, backing: .buffered, defer: false)
    window.appearance = NSAppearance(named: artifact.dark ? .darkAqua : .aqua)
    window.contentView = view
    // Off the screen it is occluded, and WebKit holds an occluded page's motion: a slide stays at its first frame.
    let occlusion = Selector(("_setWindowOcclusionDetectionEnabled:"))
    if view.responds(to: occlusion) {
      typealias Set = @convention(c) (AnyObject, Selector, Bool) -> Void
      unsafeBitCast(view.method(for: occlusion), to: Set.self)(view, occlusion, false)
    }
    window.orderBack(nil)
    defer { window.orderOut(nil) }
    coordinator.load(into: view)
    try await Task.sleep(for: .milliseconds(300))
    for _ in 0..<100 where view.isLoading { try await Task.sleep(for: .milliseconds(50)) }
    // The runtimes lay out after the load, and a deck is hosted once it reports.
    try await Task.sleep(for: .seconds(1.2))
    for _ in 0..<steps {
      deck.press("next")
      try await Task.sleep(for: .milliseconds(600))
    }
    let config = WKSnapshotConfiguration()
    config.rect = view.bounds
    return try await view.takeSnapshot(configuration: config)
  }

  /// The frame's place in the viewer, at this phone's size: laid out once with nothing in it, and measured.
  func frameSize(_ shelf: ArtifactShelf, phone: CGSize, deck: DeckRemote?) -> CGSize {
    let probe = SizeProbe()
    let host = NSHostingView(rootView: PhoneFrame(size: phone) {
      ArtifactScreen(shelf: shelf, close: {}, deck: deck) { _, _, _ in
        GeometryReader { box in Color.clear.onAppear { probe.size = box.size } }
      }
    })
    host.frame = CGRect(origin: .zero, size: phone)
    let window = NSWindow(contentRect: host.frame, styleMask: .borderless, backing: .buffered, defer: false)
    window.contentView = host
    host.layoutSubtreeIfNeeded()
    _ = host.bitmapImageRepForCachingDisplay(in: host.bounds).map { host.cacheDisplay(in: host.bounds, to: $0) }
    return probe.size
  }

  private func viewer(_ kind: String, steps: Int = 0) async throws {
    let fixture = try Self.fixture(kind)
    for phone in Self.phones {
      for theme in ["dark", "light"] {
        let dark = theme == "dark"
        let shelf = ArtifactShelf()
        shelf.open(fixture.id, title: fixture.title, dark: dark)
        let artifact = fixture.artifact(dark: dark)
        shelf.received(
          ArtifactOpened(
            id: fixture.id, title: fixture.title, kind: kind, place: ChatPlace(kind: "project", name: "Garden"),
            updatedAt: (Date().timeIntervalSince1970 - 2 * 3600) * 1000, document: artifact.document, themes: fixture.themes, theme: theme))
        let deck = kind == "deck" ? DeckRemote(place: .init(index: steps, count: 4)) : nil
        let size = frameSize(shelf, phone: phone.size, deck: deck)
        #expect(size.width == phone.size.width - 2 * ArtifactScreen<Color>.gutter, "the \(kind) does not take the phone's width in the dashboard's gutter")
        let image = try await picture(artifact, size: size, steps: steps)
        try draw("artifact-\(kind)", phone: phone, theme: theme) {
          ArtifactScreen(shelf: shelf, close: {}, deck: deck) { _, _, _ in
            Image(nsImage: image).resizable().frame(width: size.width, height: size.height)
          }
          .environment(\.colorScheme, dark ? .dark : .light)
        }
      }
    }
  }

  @Test func aDocToRead() async throws {
    try await viewer("doc")
  }

  @Test func aDeckSlideBySlide() async throws {
    try await viewer("deck", steps: 1)
  }

  @Test func aSheetThatScrollsSideways() async throws {
    try await viewer("sheet")
  }

  @Test func anArtifactOnItsWayAndOneThatDidNotOpen() throws {
    let loading = ArtifactShelf()
    loading.open("garden-doc", title: "Beds for the new season", dark: true)
    try render("artifact-loading", only: ["390"]) { ArtifactScreen(shelf: loading, close: {}) { _, _, _ in Color.clear } }
    let failed = ArtifactShelf()
    failed.open("garden-doc", title: "Beds for the new season", dark: true)
    failed.received(ArtifactOpened(id: "garden-doc", error: "KOS's dashboard build is not on this machine; build the UI so KOS can show artifacts."))
    try render("artifact-failed", only: ["390"]) { ArtifactScreen(shelf: failed, close: {}) { _, _, _ in Color.clear } }
  }

  @Test func theBoxWithTwoFilesGoingWithTheWords() throws {
    let phone = Phone.preview()
    conversation(phone)
    let tray = phone.tray
    tray.addPicture(Self.receipt())
    tray.addFile(Data("%PDF-1.7".utf8), name: "Lease renewal 2026.pdf")
    phone.chat.draft = "What do these say about the deposit?"
    try render("chat-attachments") { ChatScreen(phone: phone) }
    KOSType.scale = 1.35
    defer { KOSType.scale = nil }
    try render("chat-attachments-large-text", only: ["390"]) { ChatScreen(phone: phone) }
  }

  @Test func theChatsWithTheArtifactsToRead() throws {
    let phone = Phone.preview()
    conversation(phone)
    let now = Date()
    phone.chat.chats([
      .init(id: "phone:owner", title: "Saturday plans", updated: now.addingTimeInterval(-120), place: .kos),
      .init(id: "c2", title: "Groceries", updated: now.addingTimeInterval(-3 * 3600), place: .kos),
      .init(id: "c3", title: "Bed layout", updated: now.addingTimeInterval(-26 * 3600), place: .project("Garden")),
    ])
    let ms = now.timeIntervalSince1970 * 1000
    phone.artifacts.received(try JSONDecoder().decode(ArtifactList.self, from: Data(#"{"artifacts":[{"id":"garden-doc","title":"Beds for the new season","kind":"doc","updatedAt":\#(ms - 2 * 3_600_000)},{"id":"garden-deck","title":"Garden plan","kind":"deck","updatedAt":\#(ms - 26 * 3_600_000)},{"id":"garden-sheet","title":"Garden costs","kind":"sheet","updatedAt":\#(ms - 3 * 86_400_000)},{"id":"older","title":"Older one","kind":"page","updatedAt":1}]}"#.utf8)))
    try render("chats-artifacts") {
      SheetOver(height: 0.8) { ChatScreen(phone: phone) } sheet: { ChatPicker(chat: phone.chat, shelf: phone.artifacts) { _ in } read: { _ in } }
    }
  }

  /// A photo of a receipt: a pale slip with lines on a dark table.
  static func receipt() -> Data {
    let image = NSImage(size: NSSize(width: 600, height: 800), flipped: false) { rect in
      NSColor(calibratedRed: 0.28, green: 0.22, blue: 0.18, alpha: 1).setFill()
      rect.fill()
      let slip = NSRect(x: 150, y: 80, width: 300, height: 640)
      NSColor(calibratedWhite: 0.96, alpha: 1).setFill()
      slip.fill()
      NSColor(calibratedWhite: 0.55, alpha: 1).setFill()
      for i in 0..<14 { NSRect(x: 180, y: 660 - CGFloat(i) * 40, width: i % 3 == 0 ? 160 : 240, height: 10).fill() }
      return true
    }
    let tiff = image.tiffRepresentation ?? Data()
    return NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) ?? Data()
  }
}

/// Where a measured size lands.
@MainActor
final class SizeProbe {
  var size: CGSize = .zero
}
