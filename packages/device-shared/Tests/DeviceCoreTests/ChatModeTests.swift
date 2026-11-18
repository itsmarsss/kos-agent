import Foundation
import Testing

@testable import DeviceCore

/// The chat's mode as KOS sends it and as the window sets it, in the dashboard's words.
@Suite("Chat mode")
struct ChatModeTests {
  private let now = Date(timeIntervalSince1970: 1_700_000_000)

  private func show(_ params: String) throws -> ChatShow {
    let raw = #"{"t":"call","id":1,"method":"chat.show","params":{"title":"Mac","messages":[],"# + params + "}}"
    guard case .call(let call) = try Inbound.decode(Data(raw.utf8)) else { throw DeviceError.badRequest("not a call") }
    return try call.params(ChatShow.self)
  }

  private func data(_ mode: ChatMode) throws -> [String: Any] {
    let frame = try JSONSerialization.jsonObject(with: ChatEvent.mode(mode).frame()) as? [String: Any]
    #expect(frame?["name"] as? String == "chat.mode")
    return try #require(frame?["data"] as? [String: Any])
  }

  @Test func readsTheModeKOSShowsAndFallsBackToTheOldWord() throws {
    #expect(try show(#""mode":{"mode":"auto","until":"task","sessions":true},"auto":true"#).chatMode == ChatMode(.auto, until: .task, sessions: true))
    #expect(try show(#""mode":{"mode":"auto","until":1700003600000}"#).chatMode == ChatMode(.auto, until: .at(now.addingTimeInterval(3600))))
    #expect(try show(#""mode":{"mode":"ask","sessions":true}"#).chatMode == .ask)
    #expect(try show(#""auto":true"#).chatMode == ChatMode(.auto))
    #expect(try show(#""auto":false"#).chatMode == .ask)
    #expect(try show("\"x\":1").chatMode == .ask)
  }

  @Test func writesTheModeAsKOSReadsIt() throws {
    let ask = try data(.ask)
    #expect(ask["mode"] as? String == "ask")
    #expect(ask.count == 1)
    let task = try data(ChatMode(.auto, until: .task, sessions: true))
    #expect(task["until"] as? String == "task")
    #expect(task["sessions"] as? Bool == true)
    let timed = try data(ChatMode(.auto, until: .at(now)))
    #expect((timed["until"] as? NSNumber)?.doubleValue == 1_700_000_000_000)
    #expect(timed["sessions"] == nil)
  }

  @Test func cyclesAndRunsOut() {
    #expect(ChatMode.ask.cycled == ChatMode(.auto))
    #expect(ChatMode(.auto, until: .task, sessions: true).cycled == .ask)
    let hour = ChatMode(.auto, until: .at(now.addingTimeInterval(3600)))
    #expect(hour.live(now: now) == hour)
    #expect(hour.live(now: now.addingTimeInterval(3600)) == .ask)
    #expect(ChatMode(.ask, until: .task, sessions: true) == .ask)
  }

  @Test func theMenuKeepsWhatItShould() {
    let auto = ChatMode(.auto, until: .task, sessions: true)
    #expect(auto.picking(.ask) == .ask)
    #expect(auto.picking(.auto) == auto)
    #expect(ChatMode.ask.picking(.auto) == ChatMode(.auto))
    #expect(auto.lasting(.eight, now: now) == ChatMode(.auto, until: .at(now.addingTimeInterval(8 * 3600)), sessions: true))
    #expect(ChatMode.ask.lasting(.off, now: now) == ChatMode(.auto))
    #expect(auto.starting(sessions: false) == ChatMode(.auto, until: .task))
    #expect(ChatMode(.auto).span == .off)
    #expect(auto.span == .task)
    #expect(ChatMode(.auto, until: .at(now)).span == nil)
  }

  @Test func saysItAsTheDashboardDoes() {
    #expect(ChatMode.ask.label(now: now) == "Ask")
    #expect(ChatMode(.auto).label(now: now) == "Auto")
    #expect(ChatMode(.auto, until: .task).label(now: now) == "Auto · this task")
    #expect(ChatMode(.auto, until: .at(now.addingTimeInterval(7 * 3600 + 40 * 60))).label(now: now) == "Auto · 7h 40m")
    #expect(ChatMode(.auto, until: .at(now.addingTimeInterval(-1))).label(now: now) == "Ask")
    #expect(ChatMode.leftWords(30) == "under a minute")
    #expect(ChatMode.leftWords(45 * 60) == "45m")
    #expect(ChatMode.leftWords(7 * 3600) == "7h")
    #expect(ChatMode.ask.tip(now: now) == "Ask: KOS asks you before anything risky in this chat. Shift+Tab or press to change; more in the menu.")
    #expect(ChatMode.ask.tip(now: now, keys: false).hasSuffix("Tap to change; more in the menu."))
    #expect(ChatMode.never.count == 11)
  }
}
