import DeviceCore
import Foundation
import Testing

@testable import DeviceKit

/// The chat calls a KOS makes, drawn into the model one way for every device: what the Mac's window drew, the phone draws.
@MainActor
@Suite("Chat calls drawn")
struct ChatCallsTests {
  private func call(_ method: String, _ params: String) throws -> (Call, ChatMethod) {
    let json = #"{"t":"call","id":3,"method":""# + method + #"","params":"# + params + "}"
    guard case .call(let call) = try Inbound.decode(Data(json.utf8)), let known = ChatMethod(rawValue: method) else {
      throw DeviceError.badRequest("not a chat call")
    }
    return (call, known)
  }

  private func draw(_ model: ChatModel, _ method: String, _ params: String) throws -> ChatCalls.Heard {
    let (c, m) = try call(method, params)
    return try ChatCalls.draw(c, as: m, into: model)
  }

  @Test func theChatShownIsDrawnAndSaysSo() throws {
    let model = ChatModel()
    model.silent = true
    let heard = try draw(model, "chat.show", #"{"chat":"phone:owner","title":"Groceries","messages":[{"role":"you","text":"milk?"},{"role":"steps","steps":[{"summary":"Read the list","failed":true}]},{"role":"kos","text":"Yes, **two**."},{"role":"later","text":"?"}],"pictures":{"4":"QUJD"}}"#)
    #expect(heard == .shown)
    #expect(!model.silent)
    #expect(model.conversation == "phone:owner")
    #expect(model.title == "Groceries")
    #expect(model.lines == [.you("milk?", files: []), .steps([.init(summary: "Read the list", failed: true)]), .kos("Yes, **two**.")])
    #expect(model.pictures[4] == Data("ABC".utf8))
  }

  @Test func aStatusTellsTheTurnAndAStepsPictureAlone() throws {
    let model = ChatModel()
    try draw(model, "chat.show", #"{"chat":"c1","title":"Chat","messages":[]}"#)
    model.say("plan my week")
    #expect(try draw(model, "chat.status", #"{"chat":"c1","said":"plan my week","taken":true}"#) == .status)
    #expect(model.working)
    try draw(model, "chat.status", #"{"chat":"c1","said":"plan my week","story":"› Read the calendar","waiting":"approval","held":false}"#)
    #expect(model.story == "› Read the calendar")
    #expect(model.waiting == .approval)
    #expect(try draw(model, "chat.status", #"{"chat":"c1","said":"plan my week","frame":{"id":9,"image":"QUJD"}}"#) == .status)
    #expect(model.liveFrames == [9])
    // Done: the story closes; the chat shown next has the answer.
    try draw(model, "chat.status", #"{"chat":"c1","said":"plan my week","story":null}"#)
    #expect(model.stories.isEmpty)
  }

  @Test func anAskAndItsSettlingComeAndGo() throws {
    let model = ChatModel()
    try draw(model, "chat.show", #"{"chat":"c1","title":"Chat","messages":[]}"#)
    try draw(model, "chat.ask", #"{"chat":"c1","approval":{"id":"12","tool":"shell.run","args":"{\"cmd\":\"ls\"}","mechanics":"run ls","why":"to list the files","always":"Always for ls","expiresAt":1800000000000}}"#)
    let ask = try #require(model.asks.first)
    #expect(ask.tool == "shell.run")
    #expect(ask.mechanics == "run ls")
    #expect(ask.why == "to list the files")
    #expect(ask.always == "Always for ls")
    #expect(ask.expires == Date(timeIntervalSince1970: 1_800_000_000))
    // An ask made in another chat than the one shown is not this one's.
    try draw(model, "chat.ask", #"{"chat":"c2","approval":{"id":"13","tool":"fs.write"}}"#)
    #expect(model.asks.map(\.id) == ["12"])
    try draw(model, "chat.settled", #"{"approval":"12","outcome":"approved"}"#)
    #expect(model.asks.isEmpty)
  }

  @Test func theChatsComeWithWhereEachLives() throws {
    let model = ChatModel()
    try draw(model, "chat.chats", #"{"current":"c1","chats":[{"id":"c1","title":"KOS","updatedAt":1800000000000,"place":{"kind":"kos"}},{"id":"c2","title":"Beds","updatedAt":1700000000000,"place":{"kind":"project","name":"Garden"}},{"id":"c3","title":"Scout","updatedAt":1600000000000,"place":{"kind":"blob","name":"scout"}},{"id":"c4","title":"Old","updatedAt":1500000000000}]}"#)
    #expect(model.chats.map(\.place) == [.kos, .project("Garden"), .blob("scout"), nil])
    #expect(model.chats.first?.updated == Date(timeIntervalSince1970: 1_800_000_000))
  }

  @Test func theModelsAndMentionsAreKept() throws {
    let model = ChatModel()
    try draw(model, "chat.models", #"{"current":"gpt-5.5","choices":["gpt-5.5","gpt-5.4-mini"]}"#)
    #expect(model.models == .init(current: "gpt-5.5", choices: ["gpt-5.5", "gpt-5.4-mini"]))
    try draw(model, "chat.mentions", #"{"q":"gar","mentions":[{"kind":"project","id":"garden","label":"Garden"}]}"#)
    #expect(model.mentions == [.init(kind: "project", id: "garden", label: "Garden")])
  }

  @Test func paramsThatDoNotReadAreABadRequest() throws {
    let model = ChatModel()
    #expect(throws: DeviceError.self) { try draw(model, "chat.show", #"{"title":4}"#) }
  }
}
