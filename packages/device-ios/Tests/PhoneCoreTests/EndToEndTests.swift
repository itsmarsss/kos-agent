import DeviceCore
import DeviceKit
import DeviceLink
import CoreGraphics
import Foundation
import ImageIO
import OSLog
import Testing

@testable import PhoneCore

/// The phone against a real KOS, as scripts/e2e.sh sets one up: a scratch host whose Wi-Fi listener is on,
/// a pairing link with its pin, and a stub model. Skipped unless the script ran it.
@MainActor
@Suite("End to end", .serialized, .enabled(if: ProcessInfo.processInfo.environment["KOS_E2E_LINK"] != nil))
struct EndToEndTests {
  private let env = ProcessInfo.processInfo.environment

  /// Waits for `done`, up to `seconds`; what it was waiting for is named when it does not come.
  private func until(_ what: String, _ seconds: Double = 20, _ done: () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(seconds)
    while !done() {
      guard Date() < deadline else {
        Issue.record("Timed out waiting for \(what)")
        throw DeviceError(.internal, "timed out: \(what)")
      }
      try await Task.sleep(for: .milliseconds(50))
    }
  }

  /// The dashboard's own route, as the owner's browser asks it: to set the scratch KOS up, and to check the phone's work.
  @discardableResult
  private func dashboard(_ path: String, _ body: String? = nil) async throws -> Any {
    var request = URLRequest(url: URL(string: env["KOS_E2E_DASHBOARD"]! + path)!)
    if let body {
      request.httpMethod = "POST"
      request.setValue("application/json", forHTTPHeaderField: "content-type")
      request.httpBody = Data(body.utf8)
    }
    let (data, response) = try await URLSession.shared.data(for: request)
    #expect((response as? HTTPURLResponse)?.statusCode == 200, "\(path)")
    return try JSONSerialization.jsonObject(with: data)
  }

  @Test func pairsTalksApprovesSendsAPictureReadsAnArtifactBrowsesTheDashboardAndFollowsTheTheme() async throws {
    let link = try #require(try PairingLink.parse(env["KOS_E2E_LINK"]!))
    // What the listener shows is the certificate the link pins: the probe a typed address would make agrees.
    #expect(try await PairingClient.probe(link.address) == link.pin)

    let log = Logger(subsystem: "com.itsmarsss.kos-phone.e2e", category: "line")
    let vault = MemoryVault()
    let speech = ScriptedSpeech()
    let phone = Phone(
      vault: vault, pairer: NetworkPairer(), recognizer: speech, speaker: EarSpeaker(), haptics: FeltHaptics(), preferences: MemoryPreferences(),
      line: { Connection(log: log, app: AppInfo(version: "0.1.0", platform: Phone.platform, os: "17.0")) }, name: "E2E iPhone")
    phone.start()
    phone.pairing.address = env["KOS_E2E_LINK"]!
    await phone.pairing.next()
    // A link is confirmed before its code goes: the words are the link's pin, as the dashboard shows them.
    guard case .confirm(let check) = phone.pairing.step else { Issue.record("not asking to compare"); return }
    #expect(check.words == CertificatePin.words(link.pin!))
    await phone.pairing.confirm()
    #expect(phone.pairing.error == nil, "\(phone.pairing.error ?? "")")
    let paired = try #require(phone.paired)
    #expect(paired.pin == link.pin)
    #expect(try vault.load() == [paired])

    // Proven both ways over the pinned line, and shown the chat.
    try await until("the line to be proven") { phone.chat.online }
    try await until("the glance") { phone.glance.report != nil }
    try await until("the chat to be shown") { phone.chat.conversation != nil || !phone.chat.title.isEmpty }

    // Words by voice, and the reply.
    phone.voice.press()
    try await until("listening") { phone.voice.state == .listening }
    speech.say("hello from the phone", final: true)
    try await until("KOS's reply", 30) { phone.chat.lines.contains(.kos("Hello from the stub model.")) }
    #expect(phone.chat.lines.contains(.you("hello from the phone", files: [])))

    // An ask, approved from the phone's glance, where every waiting ask is listed, and the step it allowed.
    phone.chat.say("make the e2e file")
    try await until("the ask", 30) { !phone.chat.asks.isEmpty }
    let ask = try #require(phone.chat.asks.first)
    #expect(ask.tool.hasPrefix("shell"))
    phone.glance.ask()
    try await until("the ask in the glance") { phone.glance.asks.contains { $0.id == ask.id } }
    #expect(phone.glance.waiting >= 1)
    #expect(phone.glance.asks.first { $0.id == ask.id }?.ask.tool == ask.tool)
    phone.glance.answer(ask.id, approved: true)
    #expect(phone.chat.asks.isEmpty)
    try await until("the answer after the approval", 30) { phone.chat.lines.contains(.kos("Done: the file is made.")) }
    if let ws = env["KOS_E2E_WORKSPACE"] {
      #expect(FileManager.default.fileExists(atPath: "\(ws)/phone-e2e.txt"), "the approved command did not run")
    }

    // A picture with the words: sent ahead in parts, and the turn is shown it.
    phone.tray.addPicture(try Self.photo())
    let named = phone.tray.files.map(\.name)
    phone.chat.say("what is in this picture", files: named)
    try await until("the picture's answer", 30) { phone.chat.lines.contains(.kos("I see 1 picture.")) || phone.chat.error != nil }
    #expect(phone.chat.error == nil, "\(phone.chat.error ?? "")")
    #expect(phone.chat.lines.contains(.you("what is in this picture", files: named)))
    #expect(phone.tray.files.isEmpty)

    // An artifact KOS makes, read on the phone as the dashboard draws it: listed, opened, its reads answered by KOS.
    phone.chat.say("make the e2e doc")
    try await until("the doc's turn", 30) { phone.chat.lines.filter { $0 == .kos("Done: the file is made.") }.count >= 2 }
    phone.artifacts.list()
    try await until("the artifacts") { phone.artifacts.recent.contains { $0.id == "phone-e2e-doc" } }
    #expect(phone.artifacts.recent.first { $0.id == "phone-e2e-doc" }?.kind == "doc")
    phone.artifacts.open("phone-e2e-doc", dark: true)
    try await until("the doc drawn", 30) {
      if case .open = phone.artifacts.shown { return true }
      return false
    }
    guard case .open(let doc) = phone.artifacts.shown else { return }
    #expect(doc.title == "Phone e2e" && doc.kind == "doc" && doc.dark)
    // The dashboard's frame, read-only, with the runtime, the policy and the bridge inline: nothing to fetch.
    #expect(doc.document.contains("Read on the phone, as the dashboard draws it."))
    #expect(doc.document.contains("data-locked"))
    #expect(doc.document.contains("default-src &#39;none&#39;") || doc.document.contains("default-src 'none'"))
    #expect(!doc.themes.light.isEmpty && !doc.themes.dark.isEmpty)
    var answer: ArtifactShelf.Answer?
    phone.artifacts.read("file", args: .object(["path": .string("notes.md")])) { answer = $0 }
    try await until("the read's answer") { answer != nil }
    if case .failure(let refused) = answer { #expect(!refused.message.isEmpty) }
    phone.artifacts.open("no-such-artifact", dark: false)
    try await until("the refusal") {
      if case .failed = phone.artifacts.shown { return true }
      return false
    }
    phone.artifacts.close()

    try await browsesTheDashboard(phone)

    // The dashboard's theme, sent as the owner changes it.
    try await dashboard("/api/settings/theme", #"{"theme":"dark"}"#)
    try await until("the dark theme") { phone.mode == .dark }
    try await dashboard("/api/settings/theme", #"{"theme":"light"}"#)
    try await until("the light theme") { phone.mode == .light }

    // Stop goes through: no turn is left running.
    phone.chat.stop()
    #expect(!phone.chat.busy || phone.chat.working)

    phone.unpair()
    #expect(try vault.load().isEmpty)
  }

  /// The dashboard's pages over the line: an ask denied from the Inbox, a project opened, a schedule run now and paused,
  /// and a file read, each through the one request the phone makes of the dashboard's own routes.
  private func browsesTheDashboard(_ phone: Phone) async throws {
    let board = phone.board

    // The Inbox lists the ask the chat has, and denies it as the device; it then reads as decided.
    phone.chat.say("make the inbox file")
    try await until("the Inbox's ask", 30) { !phone.chat.asks.isEmpty }
    let asked = try #require(phone.chat.asks.first)
    await board.inbox.refresh()
    let waiting = try #require(board.inbox.waiting.value?.approvals.first { String($0.id) == asked.id }, "the Inbox does not list the ask")
    #expect(waiting.tool == asked.tool)
    await board.inbox.decide(waiting, approved: false)
    #expect(board.toasts.shown == nil, "\(board.toasts.shown?.words ?? "")")
    #expect(board.inbox.waiting.value?.approvals.contains { $0.id == waiting.id } == false)
    #expect(phone.chat.asks.isEmpty)
    #expect(board.inbox.decided.first { $0.id == waiting.id }?.status == "denied")
    let decided = try await dashboard("/api/approvals/\(waiting.id)") as? [String: Any]
    #expect(decided?["status"] as? String == "denied")
    if let ws = env["KOS_E2E_WORKSPACE"] {
      #expect(!FileManager.default.fileExists(atPath: "\(ws)/phone-inbox.txt"), "the denied command ran")
    }

    // A project made on the dashboard, opened on the phone.
    let made = try await dashboard("/api/projects/create", #"{"name":"Phone e2e garden","type":"tracker"}"#) as? [String: Any]
    let slug = try #require(made?["slug"] as? String)
    await board.projects.list.refresh()
    #expect(board.projects.list.value?.contains { $0.slug == slug } == true, "\(board.projects.list.error ?? "")")
    let project = board.projects.page(slug)
    await project.refresh()
    #expect(project.value?.project.name == "Phone e2e garden", "\(project.error ?? "")")

    // A schedule run now from the phone, its action done in the workspace, then paused.
    let job = try await dashboard(
      "/api/crons/create", #"{"name":"phone e2e","schedule":"0 3 * * *","type":"actions","actions":[{"tool":"files.write","args":{"path":"phone-cron.txt","content":"ran"}}]}"#
    ) as? [String: Any]
    let id = try #require(job?["id"] as? Int)
    await board.runs.refresh()
    #expect(board.runs.crons.value?.contains { $0.id == id } == true, "\(board.runs.crons.error ?? "")")
    await board.runs.runNow(id: id, name: "phone e2e")
    // Answered once it fired: under way, or done already, being quick.
    #expect(["Running phone e2e", "Ran phone e2e"].contains(board.toasts.shown?.words ?? ""), "\(board.toasts.shown?.words ?? "")")
    if let ws = env["KOS_E2E_WORKSPACE"] {
      try await until("the schedule's action") { FileManager.default.fileExists(atPath: "\(ws)/phone-cron.txt") }
    }
    await board.runs.setEnabled(id: id, name: "phone e2e", false)
    #expect(board.runs.crons.value?.first { $0.id == id }?.enabled == false)
    let jobs = try await dashboard("/api/crons") as? [[String: Any]]
    #expect(jobs?.first { $0["id"] as? Int == id }?["enabled"] as? Bool == false)

    // The workspace browsed, and a file read.
    let top = board.files.folder(".")
    await top.refresh()
    #expect(top.value?.entries.contains { $0.path == "phone-cron.txt" } == true, "\(top.error ?? "")")
    let file = board.files.file("phone-cron.txt")
    await file.refresh()
    guard case .text(let read) = file.value else {
      Issue.record("the file did not read: \(file.error ?? "")")
      return
    }
    #expect(read.text == "ran")
    // Nothing off the list goes through: a traversal is refused before the jail sees it.
    let outside = board.files.folder("../etc")
    await outside.refresh()
    #expect(outside.value == nil && outside.error != nil)
  }

  /// A camera's picture, big enough that the phone brings it down before it sends it.
  static func photo() throws -> Data {
    let context = try #require(CGContext(data: nil, width: 3000, height: 2000, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
    context.setFillColor(CGColor(red: 0.9, green: 0.5, blue: 0.2, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: 3000, height: 2000))
    let out = NSMutableData()
    let destination = try #require(CGImageDestinationCreateWithData(out, "public.png" as CFString, 1, nil))
    CGImageDestinationAddImage(destination, try #require(context.makeImage()), nil)
    #expect(CGImageDestinationFinalize(destination))
    return out as Data
  }

  @Test func aLineToAnotherCertificateIsRefused() async throws {
    let link = try #require(try PairingLink.parse(env["KOS_E2E_LINK"]!))
    let wrong = String(repeating: "A", count: 43)
    #expect(CertificatePin.isValid(wrong))
    let line = Connection(log: Logger(subsystem: "com.itsmarsss.kos-phone.e2e", category: "line"), app: AppInfo(version: "0.1.0", platform: "ios", os: "17.0"))
    var seen: [Connection.Status] = []
    line.onStatus = { seen.append($0) }
    line.start(Pairing(deviceId: "dev_nobody", address: link.address.base.absoluteString, hostKey: Data(repeating: 1, count: 32).base64EncodedString(), deviceKey: DeviceKey().rawRepresentation, name: "x", pin: wrong))
    try await until("the refusal") { seen.contains(.untrusted) }
    line.stop()
    // Pairing to the wrong certificate sends no code.
    await #expect(throws: DeviceError.self) { try await PairingClient.pair(link, name: "x", platform: "ios", pin: wrong) }
  }
}
