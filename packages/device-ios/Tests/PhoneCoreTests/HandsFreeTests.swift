import DeviceCore
import Foundation
import Testing

@testable import PhoneCore

/// Ask KOS from outside the app: the intent starts listening, once, in the chat, and no link does.
@MainActor
@Suite("Hands-free")
struct HandsFreeTests {
  @Test func listensAtOnceWhenKOSIsThere() async throws {
    let rig = try await Rig.online()
    rig.phone.listen()
    try await until("listening") { rig.phone.voice.state == .listening }
    #expect(rig.speech.starts == 1)
    // Asked again while listening, it does not start over.
    rig.phone.listen()
    await settle()
    #expect(rig.speech.starts == 1)
  }

  @Test func askedTwiceBeforeListeningItStartsOnce() async throws {
    let rig = try await Rig.online()
    rig.phone.listen()
    rig.phone.listen()
    try await until("listening") { rig.phone.voice.state == .listening }
    await settle()
    #expect(rig.speech.starts == 1)
  }

  @Test func waitsForTheChatBeforeListeningOnAColdStart() async throws {
    let rig = Rig(paired: Rig.pairing)
    rig.phone.start()
    rig.phone.listen()
    await settle()
    #expect(rig.phone.voice.state == .idle)
    rig.line.onStatus?(.connected(name: "iPhone"))
    await settle()
    #expect(rig.phone.voice.state == .idle)
    _ = try await rig.line.call("chat.show", #"{"chat":"phone:owner","title":"iPhone","messages":[]}"#)
    try await until("listening") { rig.phone.voice.state == .listening }
  }

  @Test func listensToNothingUnpaired() async {
    let rig = Rig()
    rig.phone.start()
    rig.phone.listen()
    await settle()
    #expect(rig.phone.voice.state == .idle && rig.speech.starts == 0)
  }

  @Test func eachAskIsTakenOnce() {
    let handsFree = HandsFree()
    #expect(!handsFree.take())
    handsFree.ask()
    handsFree.ask()
    #expect(handsFree.asked == 2)
    #expect(handsFree.take())
    // A scene that comes back later hears nothing more.
    #expect(!handsFree.take())
  }

  @Test func listeningClosesAnOpenArtifact() async throws {
    let rig = try await Rig.online()
    rig.phone.artifacts.open("plan", dark: false)
    #expect(rig.phone.artifacts.shown != nil)
    rig.phone.listen()
    #expect(rig.phone.artifacts.shown == nil)
    try await until("listening") { rig.phone.voice.state == .listening }
  }
}
