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

  @Test func readsAFaceWholeOrNotAtAll() throws {
    let raw = ##"{"t":"face","face":{"fill":"#8b5cf6","ink":"#141d29","eyes":"sparkle","gait":2,"shape":{"aspect":1.02,"squat":0.12,"spread":1,"lobes":[{"k":3,"amp":0.05,"phase":0.4}]}}}"##
    guard case .face(let face) = try Inbound.decode(Data(raw.utf8)) else { Issue.record("not a face"); return }
    #expect(face.eyes == "sparkle")
    #expect(FaceDrawing.rgb(face.fill) == 0x8B5CF6)
    #expect(face.shape.lobes == [FaceDrawing.Lobe(k: 3, amp: 0.05, phase: 0.4)])
    let badColour = raw.replacingOccurrences(of: "#8b5cf6", with: "#+8b5cf")
    #expect(throws: DeviceError.self) { try Inbound.decode(Data(badColour.utf8)) }
    let wildLump = raw.replacingOccurrences(of: #""amp":0.05"#, with: #""amp":0.9"#)
    #expect(throws: DeviceError.self) { try Inbound.decode(Data(wildLump.utf8)) }
  }

  @Test func readsATheme() throws {
    for mode in ThemeMode.allCases {
      let message = try Inbound.decode(Data(#"{"t":"theme","mode":"\#(mode.rawValue)"}"#.utf8))
      #expect(message == .theme(DashboardTheme(mode: mode)))
    }
  }

  /// With the palette a dashboard draws it in; one this app does not know is dropped and the mode kept.
  @Test func readsTheDrawnPalette() throws {
    let drawn = try Inbound.decode(Data(#"{"t":"theme","mode":"system","drawn":"dark"}"#.utf8))
    #expect(drawn == .theme(DashboardTheme(mode: .system, drawn: .dark)))
    let unknown = try Inbound.decode(Data(#"{"t":"theme","mode":"system","drawn":"sepia"}"#.utf8))
    #expect(unknown == .theme(DashboardTheme(mode: .system)))
  }

  /// One this app does not know (a newer dashboard's), or none: not a theme, so the one it has stays.
  @Test func anUnknownThemeIsRefused() {
    #expect(throws: DeviceError.self) { try Inbound.decode(Data(#"{"t":"theme","mode":"sepia"}"#.utf8)) }
    #expect(throws: DeviceError.self) { try Inbound.decode(Data(#"{"t":"theme"}"#.utf8)) }
    #expect(throws: (any Error).self) { try Inbound.decode(Data(#"{"t":"theme","mode":3}"#.utf8)) }
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
    #expect(try json(Outbound.unpair()) as NSDictionary == ["t": "unpair"] as NSDictionary)
    let body = try json(Outbound.event(.sessionEnded, data: SessionEndedEvent(session: "s1", reason: .idle)))
    #expect(body["t"] as? String == "event")
    #expect(body["name"] as? String == "session.ended")
    #expect(body["data"] as? [String: String] == ["session": "s1", "reason": "idle"])
    let scrolled = try json(Outbound.event(.sessionScrolled, data: SessionScrolledEvent(session: "s1")))
    #expect(scrolled["name"] as? String == "session.scrolled")
    #expect(scrolled["data"] as? [String: String] == ["session": "s1"])
  }

  @Test func aLapsedOrWithdrawnAskIsAnAnswerThatSaysWhy() throws {
    for reason in [SessionNotGrantedResult.Reason.unanswered, .withdrawn] {
      let body = try json(Outbound.reply(id: 1, result: SessionNotGrantedResult(reason: reason)))
      #expect(body["ok"] as? Bool == true)
      let result = try #require(body["result"] as? [String: Any])
      #expect(result["granted"] as? Bool == false)
      #expect(result["reason"] as? String == reason.rawValue)
    }
  }

  @Test func theBeginAnswerSaysGranted() throws {
    let body = try json(Outbound.reply(id: 1, result: SessionBeginResult(
      until: 1_000, space: Size(width: 1232, height: 800), target: .window(app: "Figma", title: "Cover"))))
    let result = try #require(body["result"] as? [String: Any])
    #expect(result["granted"] as? Bool == true)
    #expect(result["target"] as? [String: String] == ["kind": "window", "app": "Figma", "title": "Cover"])
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
