import DeviceCore
import DeviceKit
import DeviceLink
import Foundation
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

  private func post(_ path: String, _ body: String) async throws {
    var request = URLRequest(url: URL(string: env["KOS_E2E_DASHBOARD"]! + path)!)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.httpBody = Data(body.utf8)
    let (_, response) = try await URLSession.shared.data(for: request)
    #expect((response as? HTTPURLResponse)?.statusCode == 200, "\(path)")
  }

  @Test func pairsTalksApprovesAndFollowsTheTheme() async throws {
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

    // An ask, approved from the phone, and the step it allowed.
    phone.chat.say("make the e2e file")
    try await until("the ask", 30) { !phone.chat.asks.isEmpty }
    let ask = try #require(phone.chat.asks.first)
    #expect(ask.tool.hasPrefix("shell"))
    phone.chat.answer(ask.id, approved: true)
    try await until("the answer after the approval", 30) { phone.chat.lines.contains(.kos("Done: the file is made.")) }
    if let ws = env["KOS_E2E_WORKSPACE"] {
      #expect(FileManager.default.fileExists(atPath: "\(ws)/phone-e2e.txt"), "the approved command did not run")
    }

    // The dashboard's theme, sent as the owner changes it.
    try await post("/api/settings/theme", #"{"theme":"dark"}"#)
    try await until("the dark theme") { phone.mode == .dark }
    try await post("/api/settings/theme", #"{"theme":"light"}"#)
    try await until("the light theme") { phone.mode == .light }

    // Stop goes through: no turn is left running.
    phone.chat.stop()
    #expect(!phone.chat.busy || phone.chat.working)

    phone.unpair()
    #expect(try vault.load().isEmpty)
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
