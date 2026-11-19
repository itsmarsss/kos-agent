import Foundation
import Testing

@testable import DeviceCore

/// The token a phone gives KOS for its asks, and what KOS's notifications say, as docs/computer.md has them.
@Suite("Push")
struct PushTests {
  private func frame(_ token: PushToken) throws -> [String: Any] {
    let frame = try #require(JSONSerialization.jsonObject(with: ChatEvent.push(token).frame()) as? [String: Any])
    #expect(frame["t"] as? String == "event")
    #expect(frame["name"] as? String == "push.token")
    return try #require(frame["data"] as? [String: Any])
  }

  @Test func givesTheTokenAsHexWithItsGateway() throws {
    let token = PushToken.hex(Data([0x0a, 0xff, 0x00, 0x7b]))
    #expect(token == "0aff007b")
    let data = try frame(PushToken(token: token, env: .sandbox))
    #expect(data["token"] as? String == "0aff007b")
    #expect(data["env"] as? String == "sandbox")
  }

  @Test func takesItBackWithNoToken() throws {
    #expect(try frame(.off).isEmpty)
  }

  @Test func readsTheGatewayFromTheBuildsApsEnvironment() {
    #expect(PushEnvironment(apsEnvironment: "development") == .sandbox)
    #expect(PushEnvironment(apsEnvironment: "production") == .production)
    // The build setting left unset expands to nothing: this build has no push.
    #expect(PushEnvironment(apsEnvironment: "") == nil)
    #expect(PushEnvironment(apsEnvironment: "$(KOS_APS_ENVIRONMENT)") == nil)
    #expect(PushEnvironment(apsEnvironment: nil) == nil)
  }

  @Test func readsWhatANotificationIsAbout() {
    #expect(PushNote(userInfo: ["aps": [:], "kos": ["ask": "41"]]) == .ask("41"))
    #expect(PushNote(userInfo: ["aps": ["content-available": 1], "kos": ["settled": "41"]]) == .settled("41"))
    #expect(PushNote(userInfo: ["aps": [:]]) == nil)
    #expect(PushNote(userInfo: ["kos": ["ask": "../41"]]) == nil)
    #expect(PushNote(userInfo: ["kos": ["ask": 41]]) == nil)
    #expect(PushNote(userInfo: ["kos": ["ask": "٤١"]]) == nil)
  }

  @Test func namesAnAsksNotificationAsKOSCollapsesIt() {
    #expect(PushNote.identifier(ask: "41") == "kos.ask.41")
  }
}
