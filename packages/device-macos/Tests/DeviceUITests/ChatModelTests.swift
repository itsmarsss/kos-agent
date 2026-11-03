import Foundation
import Testing

@testable import DeviceUI

/// The window's chat keeps itself as the side panel's does: the owner's words wait until they are in the chat, and a turn says how it goes.
@MainActor
@Suite("Chat window")
struct ChatModelTests {
  @Test func wordsWaitUntilTheChatHasThemAndTheTurnEndsWithAnAnswer() {
    let model = ChatModel()
    var sent: [String] = []
    model.send = { sent.append($0) }
    model.say("  what is this?  ")
    model.say("/new")
    #expect(sent == ["what is this?", "/new"])
    // A command waits for nothing but its answer.
    #expect(model.sending == ["what is this?"])
    #expect(model.working)
    model.show(conversation: "mac:owner", title: "Mac", lines: [.you("what is this?", files: [])])
    #expect(model.sending.isEmpty)
    #expect(model.working)
    model.status(taken: false, story: .some("› Look at the screen"), error: nil)
    #expect(model.story == "› Look at the screen")
    model.show(conversation: "mac:owner", title: "Mac", lines: [.you("what is this?", files: []), .kos("A deck.")])
    #expect(!model.working)
    #expect(model.story == nil)
  }

  @Test func aFailedTurnGivesTheWordsBack() {
    let model = ChatModel()
    model.say("book it")
    model.status(taken: false, story: nil, error: "KOS is halted")
    #expect(model.error == "KOS is halted")
    #expect(model.draft == "book it")
    #expect(model.sending.isEmpty)
    #expect(!model.working)
  }

  @Test func placesWhatWasAnsweredOutsideTheChatAfterTheWordsItAnswers() {
    let model = ChatModel()
    model.show(conversation: "mac:owner", title: "Mac", lines: [.you("one", files: []), .kos("1")], notice: ("Noted.", nil, false))
    model.show(conversation: "mac:owner", title: "Mac", lines: [.you("one", files: []), .kos("1"), .you("two", files: [])])
    #expect(model.items.map(\.id) == ["l0", "l1", "n0", "l2"])
  }

  @Test func decidesOnceAndForgetsAnotherChatsAsks() {
    let model = ChatModel()
    var decided: [(String, Bool, Bool)] = []
    model.decide = { decided.append(($0, $1, $2)) }
    model.show(conversation: "mac:owner", title: "Mac", lines: [])
    model.ask(.init(id: "7", tool: "computer.act", always: "Always in Keynote"))
    model.ask(.init(id: "7", tool: "computer.act"))
    #expect(model.asks.count == 1)
    model.answer("7", approved: true, remember: true)
    model.answer("7", approved: true)
    #expect(decided.count == 1)
    #expect(decided.first?.2 == true)
    model.ask(.init(id: "8", tool: "files.rm"))
    model.show(conversation: "cm1:owner", title: "Trip", lines: [])
    #expect(model.asks.isEmpty)
  }
}
