import DeviceCore
import Foundation
import Testing

@testable import PhoneCore

/// Ask KOS from outside the app: the link and the intent both start listening, and pair nothing.
@MainActor
@Suite("Hands-free")
struct HandsFreeTests {
  @Test func readsTheLinksThePhoneOpens() throws {
    #expect(PhoneLink(PhoneLink.listenURL) == .listen)
    #expect(PhoneLink(try #require(URL(string: "KOS-DEVICE://listen/"))) == .listen)
    let pair = try #require(URL(string: "kos-device://pair?url=https://192.168.1.20:4319&code=K7QX-M2PA"))
    #expect(PhoneLink(pair) == .pair(pair))
    // Words never ride with a listen, and nothing else is a phone's link.
    #expect(PhoneLink(try #require(URL(string: "kos-device://listen?say=delete%20everything"))) == nil)
    #expect(PhoneLink(try #require(URL(string: "kos-device://listen/now"))) == nil)
    #expect(PhoneLink(try #require(URL(string: "kos-device://settings"))) == nil)
    #expect(PhoneLink(try #require(URL(string: "https://listen"))) == nil)
  }

  @Test func listensAtOnceWhenKOSIsThere() async throws {
    let rig = try await Rig.online()
    rig.phone.listen()
    await settle()
    #expect(rig.phone.voice.state == .listening)
    #expect(rig.speech.starts == 1)
    // Asked again while listening, it does not start over.
    rig.phone.listen()
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
    await settle()
    #expect(rig.phone.voice.state == .listening)
  }

  @Test func listensToNothingUnpaired() async {
    let rig = Rig()
    rig.phone.start()
    rig.phone.listen()
    await settle()
    #expect(rig.phone.voice.state == .idle && rig.speech.starts == 0)
  }

  @Test func theIntentAsksTheSceneToListen() {
    let handsFree = HandsFree()
    handsFree.ask()
    handsFree.ask()
    #expect(handsFree.asked == 2)
  }
}
