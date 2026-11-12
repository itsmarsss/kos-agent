import Foundation
import Testing

@testable import DeviceCore

/// The chat KOS draws in the window: its calls read as KOS sends them, and the window's events written as KOS reads them.
@Suite("Chat on the line")
struct ChatTests {
  private func call(_ json: String) throws -> Call {
    guard case .call(let call) = try Inbound.decode(Data(json.utf8)) else { throw DeviceError.badRequest("not a call") }
    return call
  }

  private func object(_ data: Data) throws -> [String: Any] {
    try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  @Test func readsTheChatAsKOSShowsIt() throws {
    let raw = ##"{"t":"call","id":4,"method":"chat.show","params":{"conversation":"mac:owner","title":"Mac","auto":true,"messages":[{"role":"you","text":"what is this?","files":["a.png"]},{"role":"steps","steps":[{"summary":"Look at the screen"},{"summary":"Click Buy","failed":true}]},{"role":"kos","text":"A **deck**."}],"notice":{"text":"Started a new chat.","said":"/new"}}}"##
    let show = try call(raw).params(ChatShow.self)
    #expect(ChatMethod(rawValue: "chat.show") == .show)
    #expect(show.conversation == "mac:owner")
    #expect(show.auto == true)
    #expect(show.messages.map(\.role) == ["you", "steps", "kos"])
    #expect(show.messages[1].steps == [ChatStep(summary: "Look at the screen"), ChatStep(summary: "Click Buy", failed: true)])
    #expect(show.notice?.said == "/new")
  }

  @Test func readsAStepsPictureAndTheChatsNewestOnes() throws {
    let status = try call(#"{"t":"call","id":7,"method":"chat.status","params":{"conversation":"mac:owner","said":"look","frame":{"id":12,"image":"QUJD","mediaType":"image/jpeg"}}}"#).params(ChatStatus.self)
    #expect(status.frame == ChatFrame(id: 12, image: "QUJD"))
    // A picture says nothing of the story: the turn is not ended by it.
    #expect(status.story == nil)
    let show = try call(##"{"t":"call","id":8,"method":"chat.show","params":{"conversation":"mac:owner","title":"Mac","messages":[{"role":"steps","steps":[{"summary":"Look","frame":12},{"summary":"Type"}]}],"pictures":{"12":"QUJD"}}}"##).params(ChatShow.self)
    #expect(show.messages[0].steps == [ChatStep(summary: "Look", frame: 12), ChatStep(summary: "Type")])
    #expect(show.pictures == ["12": "QUJD"])
    let bare = try call(#"{"t":"call","id":9,"method":"chat.status","params":{"story":"› Look"}}"#).params(ChatStatus.self)
    #expect(bare.frame == nil)
  }

  @Test func readsAnAsksStepsBesideItsArguments() throws {
    let raw = ##"{"t":"call","id":5,"method":"chat.ask","params":{"approval":{"id":"11","tool":"computer.act","args":"{\"intent\":\"Note: just closing the popup\"}","mechanics":"Type “hunter2”, press cmd+q"}}}"##
    let ask = try call(raw).params(ChatAsk.self).approval
    #expect(ask.mechanics == "Type “hunter2”, press cmd+q")
    let plain = try call(#"{"t":"call","id":6,"method":"chat.ask","params":{"approval":{"id":"12","tool":"files.rm","args":"{}"}}}"#).params(ChatAsk.self).approval
    #expect(plain.mechanics == nil)
    let mine = try call(#"{"t":"call","id":7,"method":"chat.ask","params":{"chat":"mac:owner","approval":{"id":"13","tool":"files.rm"}}}"#).params(ChatAsk.self)
    #expect(mine.chat == "mac:owner")
  }

  @Test func tellsAStoryFromADoneTurnFromNothingSaid() throws {
    let going = try call(#"{"t":"call","id":1,"method":"chat.status","params":{"conversation":null,"story":"› Look"}}"#).params(ChatStatus.self)
    let done = try call(#"{"t":"call","id":2,"method":"chat.status","params":{"story":null}}"#).params(ChatStatus.self)
    let taken = try call(#"{"t":"call","id":3,"method":"chat.status","params":{"taken":true,"said":"hi"}}"#).params(ChatStatus.self)
    #expect(going.story == .some("› Look"))
    #expect(done.story == .some(nil))
    #expect(taken.story == nil)
    #expect(taken.taken == true)
  }

  @Test func writesTheOwnersWordsWithTheAppInFront() throws {
    let send = try object(ChatEvent.send(text: "summarize this", beside: .app(name: "Keynote", bundle: "com.apple.iWork.Keynote", title: "Q3")).frame())
    #expect(send["t"] as? String == "event")
    #expect(send["name"] as? String == "chat.send")
    let data = try #require(send["data"] as? [String: Any])
    #expect(data["text"] as? String == "summarize this")
    #expect(data["beside"] as? [String: String] == ["kind": "app", "name": "Keynote", "bundle": "com.apple.iWork.Keynote", "title": "Q3"])
    let hidden = try #require(object(ChatEvent.send(text: "x", beside: .hidden).frame())["data"] as? [String: Any])
    #expect(hidden["beside"] as? [String: String] == ["kind": "hidden"])
  }

  @Test func writesADecisionRememberedOnlyWhenTheOwnerSaidSo() throws {
    let once = try #require(object(ChatEvent.decide(approval: "7", approved: true, remember: false).frame())["data"] as? [String: Any])
    #expect(once["approval"] as? String == "7")
    #expect(once["approved"] as? Bool == true)
    #expect(once["remember"] == nil)
    let always = try #require(object(ChatEvent.decide(approval: "7", approved: true, remember: true).frame())["data"] as? [String: Any])
    #expect(always["remember"] as? Bool == true)
    #expect(try object(ChatEvent.open.frame())["name"] as? String == "chat.open")
    #expect(try object(ChatEvent.auto(true).frame())["data"] as? [String: Bool] == ["on": true])
  }

  @Test func readsWhichChatATurnIsInAndWhatItWaitsOn() throws {
    let both = try call(#"{"t":"call","id":1,"method":"chat.status","params":{"chat":"mac:owner","conversation":"old","waiting":"consent","held":true}}"#).params(ChatStatus.self)
    #expect(both.turnChat == "mac:owner")
    #expect(both.waiting == .consent)
    #expect(both.held == true)
    let old = try call(#"{"t":"call","id":2,"method":"chat.status","params":{"conversation":"mac:owner","waiting":"something new"}}"#).params(ChatStatus.self)
    #expect(old.turnChat == "mac:owner")
    #expect(old.waiting == .approval)
    #expect(old.held == nil)
    let show = try call(#"{"t":"call","id":3,"method":"chat.show","params":{"chat":"mac:owner","conversation":"mac:owner","title":"Mac","messages":[]}}"#).params(ChatShow.self)
    #expect(show.chat == "mac:owner")
    let ask = try call(#"{"t":"call","id":4,"method":"chat.ask","params":{"approval":{"id":"9","tool":"computer.act","expiresAt":1700000000000}}}"#).params(ChatAsk.self).approval
    #expect(ask.expiresAt == 1_700_000_000_000)
  }

  @Test func writesAQuoteOnceAndAStop() throws {
    let quoted = try #require(object(ChatEvent.send(text: "fix this", beside: .none, quote: Quote(text: "teh cat", from: "Notes: Draft")).frame())["data"] as? [String: Any])
    #expect(quoted["quote"] as? [String: String] == ["text": "teh cat", "from": "Notes: Draft"])
    let plain = try #require(object(ChatEvent.send(text: "hi", beside: .none).frame())["data"] as? [String: Any])
    #expect(plain["quote"] == nil)
    let stop = try object(ChatEvent.stop.frame())
    #expect(stop["name"] as? String == "chat.stop")
    #expect(stop["data"] as? [String: String] == [:])
    let mentions = try object(ChatEvent.mentions("ali").frame())
    #expect(mentions["name"] as? String == "chat.mentions")
    #expect(mentions["data"] as? [String: String] == ["q": "ali"])
  }
}
