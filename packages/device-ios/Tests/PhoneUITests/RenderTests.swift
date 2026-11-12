import AppKit
import DeviceCore
import DeviceKit
import SwiftUI
import Testing

@testable import PhoneCore
@testable import PhoneUI

/// Every screen, drawn on a Mac at iPhone sizes (iPhone 15 and 15 Pro Max), in both themes, inside a stand-in
/// of the phone's status bar and home indicator. With KOS_SNAPSHOT_DIR set each is written there as a PNG,
/// `name-390-dark.png` and so on, so the look can be seen without Xcode or a phone.
@MainActor
@Suite("Phone screens render", .serialized)
struct RenderTests {
  static let phones: [(name: String, size: CGSize)] = [("390", CGSize(width: 390, height: 844)), ("430", CGSize(width: 430, height: 932))]

  /// Draws the view in each phone and theme; the sizes it was drawn at.
  @discardableResult
  private func render<V: View>(_ name: String, only: [String]? = nil, _ view: @escaping () -> V) throws -> Int {
    var drawn = 0
    for phone in Self.phones where only?.contains(phone.name) ?? true {
      for (theme, appearance) in [("dark", NSAppearance.Name.darkAqua), ("light", .aqua)] {
        let host = NSHostingView(rootView: PhoneFrame(size: phone.size) { view() })
        host.frame = CGRect(origin: .zero, size: phone.size)
        let window = NSWindow(contentRect: host.frame, styleMask: .borderless, backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: appearance)
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        if let dir = ProcessInfo.processInfo.environment["KOS_SNAPSHOT_DIR"] {
          let rep = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
          host.cacheDisplay(in: host.bounds, to: rep)
          let png = try #require(rep.representation(using: .png, properties: [:]))
          try png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name)-\(phone.name)-\(theme).png"))
        }
        #expect(host.fittingSize.width <= phone.size.width + 0.5, "\(name) is wider than the \(phone.name) phone")
        drawn += 1
      }
    }
    return drawn
  }

  // MARK: Fixtures

  private func online(_ phone: Phone) {
    phone.chat.paired = true
    phone.chat.link = .connected
  }

  private func conversation(_ phone: Phone) {
    online(phone)
    phone.chat.show(
      conversation: "phone:owner", title: "Saturday plans",
      lines: [
        .you("What's on this weekend?", files: []),
        .steps([.init(summary: "Read the calendar"), .init(summary: "Check the weather")]),
        .kos("Saturday is clear until **4 pm**, then dinner with Sam at Lucia's.\n\n- Sunny, 21° in the afternoon\n- The bike is booked for a service at 10\n\nWant me to move the service so you can ride?"),
        .you("Yes, push it to Sunday morning", files: []),
        .steps([.init(summary: "Open the bike shop's booking page"), .init(summary: "Choose Sunday 9:00"), .init(summary: "Confirm the booking", failed: true)]),
        .kos("I couldn't confirm it: the shop's page asks for a card again. I left it at **Sunday 9:00**, ready for you to finish."),
      ])
  }

  private static let ask = ChatModel.Ask(
    id: "41", tool: "shell.run", args: #"{"command":"git -C ~/kos-workspace/garden push origin main"}"#,
    mechanics: "run: git -C garden push origin main\nthen: report what was pushed", why: "Push the garden plan you approved this morning.",
    always: "Always for git push", expires: Date().addingTimeInterval(4 * 60 + 12), chat: "phone:owner")

  private func glance() -> Glance {
    let now = Date().timeIntervalSince1970 * 1000
    return Glance(
      halted: false, running: [.init(id: "c1", title: "Garden orchestrator"), .init(id: "c2", title: "Fix login")], waiting: 3,
      asks: [
        .init(
          chat: .init(id: "c3", title: "Inbox sweep"),
          approval: ChatApproval(id: "41", tool: "email.send", args: #"{"to":"sam@example.com"}"#, why: "Reply to Sam that Saturday at 4 works.", expiresAt: now + 4 * 60_000)),
        .init(
          chat: .init(id: "c1", title: "Garden orchestrator"),
          approval: ChatApproval(id: "42", tool: "shell.run", args: #"{"command":"git push"}"#, why: "Push the garden plan you approved this morning.", expiresAt: now + 22 * 60_000)),
      ],
      failing: [.init(label: "Nightly backup", streak: 3, error: "rsync: write failed: No space left on device", since: now - 2 * 86_400_000)],
      next: [.init(name: "kos.backup", at: now + 3 * 3_600_000), .init(name: "blob.scout", at: now + 26 * 3_600_000)])
  }

  // MARK: Screens

  @Test func pairing() throws {
    try render("pairing") { PairingScreen(flow: PairingFlow(pairer: NetworkPairer()), problem: nil) }
  }

  @Test func pairingFilledWithAnError() throws {
    let flow = PairingFlow(pairer: NetworkPairer())
    flow.address = "192.168.1.20:4319"
    flow.code = "K7QX-M2PA"
    flow.note("Could not reach KOS at 192.168.1.20:4319: the request timed out.")
    try render("pairing-error", only: ["390"]) { PairingScreen(flow: flow, problem: nil) }
  }

  @Test func pairingComparesTheWords() async throws {
    let flow = PairingFlow(pairer: StandInPairer())
    flow.address = "192.168.1.20:4319"
    flow.code = "K7QX-M2PA"
    await flow.next()
    try render("pairing-words") { PairingScreen(flow: flow, problem: nil) }
  }

  @Test func pairingFromALinkComparesTheWordsToo() async throws {
    let flow = PairingFlow(pairer: StandInPairer())
    await flow.open(URL(string: "kos-device://pair?url=https://192.168.1.20:4319&code=K7QX-M2PA&pin=5M0IYxHO9_X0el-UCBYbsqpoA5nBtVocc3d18qMjq2I")!)
    try render("pairing-link", only: ["390"]) { PairingScreen(flow: flow, problem: nil) }
  }

  @Test func aLinkWhilePairedAsksToReplace() async throws {
    let flow = PairingFlow(pairer: StandInPairer())
    flow.current = { "192.168.1.20:4319" }
    await flow.open(URL(string: "kos-device://pair?url=https://192.168.1.31:4319&code=K7QX-M2PA&pin=5M0IYxHO9_X0el-UCBYbsqpoA5nBtVocc3d18qMjq2I")!)
    try render("pairing-replace") { PairingScreen(flow: flow, problem: nil) }
  }

  @Test func emptyChat() throws {
    let phone = Phone.preview()
    online(phone)
    phone.chat.show(conversation: "phone:owner", title: "iPhone", lines: [])
    try render("chat-empty") { ChatScreen(phone: phone) }
  }

  @Test func aConversation() throws {
    let phone = Phone.preview()
    conversation(phone)
    phone.reader.on = true
    try render("chat") { ChatScreen(phone: phone) }
  }

  @Test func aTurnStreamingWithStop() throws {
    let phone = Phone.preview()
    conversation(phone)
    phone.chat.say("And what about Sunday?")
    phone.chat.status(taken: true, story: nil, error: nil, said: "And what about Sunday?", conversation: "phone:owner")
    phone.chat.status(
      taken: false, story: .some("› Read the calendar\n› Check the weather\nSunday looks quieter: rain until noon, then"), error: nil,
      said: "And what about Sunday?", conversation: "phone:owner")
    try render("chat-working") { ChatScreen(phone: phone) }
  }

  @Test func listening() async throws {
    let speech = RenderSpeech()
    let phone = Phone.preview(recognizer: speech)
    conversation(phone)
    phone.voice.press()
    for _ in 0..<20 { await Task.yield() }
    speech.heard?("Remind me to call the bike shop at nine", false)
    try render("chat-listening") { ChatScreen(phone: phone) }
  }

  @Test func anAskWaiting() throws {
    let phone = Phone.preview()
    conversation(phone)
    phone.chat.ask(Self.ask)
    try render("chat-ask", only: ["390"]) { ChatScreen(phone: phone) }
    try render("approval") {
      SheetOver(height: 0.62) { ChatScreen(phone: phone) } sheet: { ApprovalSheet(chat: phone.chat) {} }
    }
  }

  @Test func theGlance() throws {
    let phone = Phone.preview()
    conversation(phone)
    phone.glance.received(glance())
    try render("glance") {
      SheetOver(height: 0.72) { ChatScreen(phone: phone) } sheet: { GlanceSheet(glance: phone.glance) }
    }
    // Scrolled to its end, open full height: the last row clears the home indicator.
    try render("glance-end", only: ["390"]) {
      SheetOver(height: 0.92) { ChatScreen(phone: phone) } sheet: { GlanceSheet(glance: phone.glance).defaultScrollAnchor(.bottom) }
    }
    let ask = try #require(phone.glance.asks.first)
    try render("glance-ask", only: ["390"]) {
      SheetOver(height: 0.62) { GlanceSheet(glance: phone.glance) } sheet: {
        AskBody(ask: ask.ask, more: 0, from: ask.chat) { _, _ in }.frame(maxHeight: .infinity, alignment: .top)
      }
    }
  }

  @Test func theChats() throws {
    let phone = Phone.preview()
    conversation(phone)
    let now = Date()
    phone.chat.chats([
      .init(id: "phone:owner", title: "Saturday plans", updated: now.addingTimeInterval(-120), place: .kos),
      .init(id: "c2", title: "Groceries", updated: now.addingTimeInterval(-3 * 3600), place: .kos),
      .init(id: "c3", title: "Bed layout", updated: now.addingTimeInterval(-26 * 3600), place: .project("Garden")),
      .init(id: "c4", title: "Watering schedule", updated: now.addingTimeInterval(-50 * 3600), place: .project("Garden")),
      .init(id: "c5", title: "Scout", updated: now.addingTimeInterval(-4 * 86_400), place: .blob("scout")),
    ])
    try render("chats") {
      SheetOver(height: 0.7) { ChatScreen(phone: phone) } sheet: { ChatPicker(chat: phone.chat) { _ in } }
    }
  }

  @Test func offline() throws {
    let phone = Phone.preview()
    conversation(phone)
    phone.chat.link = .offline("KOS is not answering.")
    try render("chat-offline", only: ["390"]) { ChatScreen(phone: phone) }
  }

  @Test func largeText() throws {
    KOSType.scale = 1.35
    defer { KOSType.scale = nil }
    let phone = Phone.preview()
    conversation(phone)
    try render("chat-large-text", only: ["390"]) { ChatScreen(phone: phone) }
    try render("approval-large-text", only: ["390"]) {
      SheetOver(height: 0.8) { ChatScreen(phone: phone) } sheet: {
        ApprovalSheet(chat: {
          let chat = ChatModel()
          chat.ask(Self.ask)
          return chat
        }()) {}
      }
    }
  }

  @Test func theMore() throws {
    let phone = Phone.preview()
    conversation(phone)
    try render("more", only: ["390"]) {
      SheetOver { ChatScreen(phone: phone) } sheet: { MoreSheet(phone: phone, reader: phone.reader) {} }
    }
  }
}

/// A microphone a render speaks into.
@MainActor
final class RenderSpeech: SpeechRecognizer {
  var heard: ((String, Bool) -> Void)?
  func requestAccess() async -> SpeechAccess { .allowed }
  func start(heard: @escaping (String, Bool) -> Void, failed: @escaping (String) -> Void) throws { self.heard = heard }
  func finish() {}
  func cancel() {}
}

/// A KOS on the Wi-Fi whose certificate is the test one.
struct StandInPairer: Pairer {
  func probe(_ address: KOSAddress) async throws -> String { "5M0IYxHO9_X0el-UCBYbsqpoA5nBtVocc3d18qMjq2I" }
  func pair(_ link: PairingLink, name: String, pin: String?) async throws -> Pairing { throw DeviceError.badRequest("not in a render") }
}

/// The phone around a screen: the status bar over the top safe area, the home indicator in the bottom one.
struct PhoneFrame<Content: View>: View {
  let size: CGSize
  @ViewBuilder let content: () -> Content

  static var top: CGFloat { 59 }
  static var bottom: CGFloat { 34 }

  var body: some View {
    content()
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .padding(.top, Self.top)
      .padding(.bottom, Self.bottom)
      .overlay(alignment: .top) { StatusBar().frame(height: Self.top) }
      .overlay(alignment: .bottom) {
        Capsule().fill(Theme.text).frame(width: 134, height: 5).padding(.bottom, 8)
      }
      .frame(width: size.width, height: size.height)
      .background(Theme.bg)
      .foregroundStyle(Theme.text)
      .tint(Theme.accent)
  }

  private struct StatusBar: View {
    var body: some View {
      ZStack {
        Capsule().fill(.black).frame(width: 125, height: 37).offset(y: -1)
        HStack {
          Text("9:41").font(.system(size: 17, weight: .semibold)).frame(width: 100)
          Spacer()
          HStack(spacing: 6) {
            Image(systemName: "cellularbars")
            Image(systemName: "wifi")
            Image(systemName: "battery.100")
          }
          .font(.system(size: 15, weight: .semibold))
          .frame(width: 100)
        }
        .padding(.horizontal, 12)
      }
      .padding(.top, 6)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
  }
}

/// A sheet as iOS presents one, drawn into the picture: the screen under it dimmed, the status bar's ground too,
/// the sheet up from the foot to `height` of the screen (or as tall as it is, with none), its top corners round
/// and its grabber showing.
struct SheetOver<Base: View, Sheet: View>: View {
  var height: CGFloat?
  @ViewBuilder let base: () -> Base
  @ViewBuilder let sheet: () -> Sheet

  var body: some View {
    GeometryReader { box in
      ZStack(alignment: .bottom) {
        base().overlay(Color.black.opacity(0.4).padding(.top, -PhoneFrame<Base>.top))
        // The home indicator is the sheet's safe area, as on a phone: a scroll view scrolled to its end clears it.
        sheet()
          .safeAreaInset(edge: .bottom, spacing: 0) { Color.clear.frame(height: PhoneFrame<Base>.bottom) }
          .frame(maxWidth: .infinity)
          .fixedSize(horizontal: false, vertical: height == nil)
          .frame(height: height.map { box.size.height * $0 + PhoneFrame<Base>.bottom }, alignment: .top)
          .background(Theme.panel)
          .clipShape(UnevenRoundedRectangle(topLeadingRadius: 38, topTrailingRadius: 38, style: .continuous))
          .overlay(alignment: .top) { Capsule().fill(Theme.lineStrong).frame(width: 36, height: 5).padding(.top, 6) }
          .offset(y: PhoneFrame<Base>.bottom)
      }
    }
  }
}
