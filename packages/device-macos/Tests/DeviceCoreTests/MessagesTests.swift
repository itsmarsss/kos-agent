import Foundation
import Testing
@testable import DeviceCore

private func json(_ data: Data) throws -> [String: Any] {
  try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
}

private let state = DeviceState(
  consent: .device,
  permissions: Permissions(screen: true, input: false),
  displays: [DisplayInfo(id: 1, width: 1512, height: 982, scale: 2, main: true)])

@Suite("Wire messages")
struct MessagesTests {
  @Test func readsAChallenge() throws {
    let message = try Inbound.decode(Data(#"{"t":"challenge","protocol":1,"nonce":"abc"}"#.utf8))
    #expect(message == .challenge(protocol: 1, nonce: "abc"))
  }

  @Test func readsAWelcome() throws {
    let message = try Inbound.decode(Data(#"{"t":"welcome","name":"Studio","signature":"sig"}"#.utf8))
    #expect(message == .welcome(name: "Studio", signature: "sig"))
  }

  @Test func readsACallAndItsParamsOnceTheMethodIsKnown() throws {
    let raw = Data(#"{"t":"call","id":7,"method":"pointer.click","params":{"session":"s1","x":10,"y":20.5,"count":2}}"#.utf8)
    guard case .call(let call) = try Inbound.decode(raw) else { Issue.record("not a call"); return }
    #expect(call.id == 7)
    #expect(call.method == "pointer.click")
    let params = try call.params(ClickParams.self)
    #expect(params.session == "s1")
    #expect(params.x == 10)
    #expect(params.y == 20.5)
    #expect(params.count == 2)
    #expect(params.button == nil)
  }

  @Test func aBadParamIsABadRequestNamingTheField() throws {
    let raw = Data(#"{"t":"call","id":3,"method":"pointer.move","params":{"session":"s1","x":"left"}}"#.utf8)
    guard case .call(let call) = try Inbound.decode(raw) else { Issue.record("not a call"); return }
    #expect(throws: DeviceError.self) { try call.params(MoveParams.self) }
    do {
      _ = try call.params(MoveParams.self)
    } catch let error as DeviceError {
      #expect(error.code == .badRequest)
      #expect(error.message.contains("x"))
    }
  }

  @Test func anUnknownTypeIsRefused() {
    #expect(throws: DeviceError.self) { try Inbound.decode(Data(#"{"t":"mystery"}"#.utf8)) }
  }

  @Test func writesTheHelloTheProtocolDescribes() throws {
    let body = try json(Outbound.hello(
      device: "dev_1", nonce: "n", signature: "s", app: AppInfo(version: "0.1.0", os: "26.4.1"), state: state))
    #expect(body["t"] as? String == "hello")
    #expect(body["protocol"] as? Int == 1)
    #expect(body["device"] as? String == "dev_1")
    #expect(body["consent"] as? String == "device")
    let permissions = try #require(body["permissions"] as? [String: Bool])
    #expect(permissions == ["screen": true, "input": false])
    let display = try #require((body["displays"] as? [[String: Any]])?.first)
    #expect(display["width"] as? Double == 1512)
    #expect(display["main"] as? Bool == true)
    let app = try #require(body["app"] as? [String: String])
    #expect(app == ["version": "0.1.0", "platform": "macos", "os": "26.4.1"])
  }

  @Test func writesState() throws {
    let body = try json(Outbound.state(state))
    #expect(body["t"] as? String == "state")
    #expect(body["consent"] as? String == "device")
    #expect(body["displays"] != nil)
  }

  @Test func writesAnAnswer() throws {
    let body = try json(Outbound.reply(id: 9, result: CursorResult(cursor: Point(x: 1, y: 2))))
    #expect(body["t"] as? String == "reply")
    #expect(body["id"] as? Int == 9)
    #expect(body["ok"] as? Bool == true)
    let cursor = try #require((body["result"] as? [String: Any])?["cursor"] as? [String: Double])
    #expect(cursor == ["x": 1, "y": 2])
  }

  @Test func writesARefusal() throws {
    let body = try json(Outbound.reply(id: 4, error: DeviceError(.secureInput, "A password field has focus.")))
    #expect(body["ok"] as? Bool == false)
    let error = try #require(body["error"] as? [String: String])
    #expect(error == ["code": "secure_input", "message": "A password field has focus."])
  }

  @Test func writesAnEvent() throws {
    let body = try json(Outbound.event(.sessionEnded, data: SessionEndedEvent(session: "s1", reason: .idle)))
    #expect(body["t"] as? String == "event")
    #expect(body["name"] as? String == "session.ended")
    #expect(body["data"] as? [String: String] == ["session": "s1", "reason": "idle"])
  }

  @Test func theBeginAnswerSaysGranted() throws {
    let body = try json(Outbound.reply(id: 1, result: SessionBeginResult(until: 1_000, space: Size(width: 1232, height: 800))))
    let result = try #require(body["result"] as? [String: Any])
    #expect(result["granted"] as? Bool == true)
    #expect(result["until"] as? Int == 1_000)
    #expect(result["space"] as? [String: Double] == ["width": 1232, "height": 800])
  }

  @Test func everyErrorCodeIsTheProtocolsSpelling() {
    let spelled = [ErrorCode.noSession, .paused, .busy, .denied, .permission, .secureInput, .hiddenApp, .badRequest, .internal]
      .map(\.rawValue)
    #expect(spelled == ["no_session", "paused", "busy", "denied", "permission", "secure_input", "hidden_app", "bad_request", "internal"])
  }

  @Test func everyMethodIsTheProtocolsSpelling() {
    #expect(CallMethod.allCases.map(\.rawValue) == [
      "session.begin", "session.end", "screen.capture", "pointer.move", "pointer.click", "pointer.drag",
      "pointer.scroll", "keys.type", "keys.press",
    ])
  }
}
