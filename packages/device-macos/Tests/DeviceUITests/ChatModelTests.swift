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

  /// A step's picture shows under the running steps, stays with the chat by its frame id, and the oldest go past the cap.
  @Test func keepsStepPicturesLiveAndInTheChat() {
    let model = ChatModel()
    let abc = Data("ABC".utf8).base64EncodedString()
    model.show(conversation: "mac:owner", title: "Mac", lines: [.you("look", files: [])])
    model.status(taken: false, story: .some("› Look at the screen"), error: nil)
    model.frame(3, image: abc, conversation: "mac:owner")
    // Another chat's, and one that is not a picture, are not kept.
    model.frame(4, image: abc, conversation: "cm1:owner")
    model.frame(5, image: "not base64!", conversation: "mac:owner")
    #expect(model.liveFrames == [3])
    #expect(model.picturesOf([3, nil, 4]).map(\.id) == [3])
    #expect(model.story == "› Look at the screen")
    // The answer lands: the live pictures go, the chat's steps keep theirs by id.
    model.show(conversation: "mac:owner", title: "Mac", lines: [.you("look", files: []), .steps([.init(summary: "Look at the screen", frame: 3)]), .kos("A deck.")])
    #expect(model.liveFrames.isEmpty)
    #expect(model.picturesOf([3]).first?.data == Data("ABC".utf8))
    // The chat's own newest pictures are kept too, and only the newest past the cap.
    var sent: [Int: String] = [:]
    for i in 100..<(100 + ChatModel.picturesKept + 2) { sent[i] = abc }
    model.show(conversation: "mac:owner", title: "Mac", lines: [], pictures: sent)
    #expect(model.pictures.count == ChatModel.picturesKept)
    #expect(model.pictures[3] == nil)
    #expect(model.pictures[100 + ChatModel.picturesKept + 1] != nil)
    // Another chat starts with none.
    model.show(conversation: "cm1:owner", title: "Trip", lines: [])
    #expect(model.pictures.isEmpty)
  }

  /// Words after the steps are not the end of the turn: its foot says it works until the turn ends.
  @Test func aRunningTurnKeepsItsFootAfterWords() {
    let model = ChatModel()
    model.show(conversation: "mac:owner", title: "Mac", lines: [])
    #expect(model.foot == nil)
    model.say("count the books")
    #expect(model.foot == "Thinking")
    #expect(model.workingSince != nil)
    model.status(taken: false, story: .some("› Run a query"), error: nil)
    #expect(model.foot == "Run a query")
    model.status(taken: false, story: .some("› Run a query\nData check first: 17 books. Building page 1 now."), error: nil)
    #expect(model.working)
    #expect(model.foot == "Working")
    model.status(taken: false, story: .some(nil), error: nil)
    #expect(model.foot == nil)
    #expect(model.workingSince == nil)
  }

  /// Held on an ask, the turn is the owner's to move: its foot says so, and goes back to working once answered.
  @Test func aTurnHeldOnAnAskWaitsOnTheOwner() {
    let model = ChatModel()
    model.show(conversation: "mac:owner", title: "Mac", lines: [])
    model.say("clear the build")
    model.status(taken: false, story: .some("› Run rm build"), error: nil)
    model.ask(ChatModel.Ask(id: "a1", tool: "shell.run"))
    #expect(model.waitingOnOwner)
    #expect(model.foot == "Waiting on you")
    model.answer("a1", approved: true)
    #expect(!model.waitingOnOwner)
    #expect(model.foot == "Run rm build")
  }

  /// Words queued behind a turn, taken once it is done: the next turn counts from its own start.
  @Test func aQueuedTurnStartsItsOwnClock() async throws {
    let model = ChatModel()
    model.show(conversation: "mac:owner", title: "Mac", lines: [])
    model.say("count the books")
    model.status(taken: true, story: nil, error: nil, said: "count the books", conversation: "mac:owner")
    let first = try #require(model.workingSince)
    try await Task.sleep(for: .milliseconds(20))
    model.status(taken: true, story: nil, error: nil, said: "count the books", conversation: "mac:owner")
    #expect(model.workingSince == first)
    model.status(taken: true, story: nil, error: nil, said: "and the shelves", conversation: "mac:owner")
    #expect(try #require(model.workingSince) > first)
  }

  @Test func aTurnTakenElsewhereShowsAsItGoes() {
    let model = ChatModel()
    model.show(conversation: "mac:owner", title: "Mac", lines: [])
    // Said on the dashboard: on its way here, then its steps, then the chat with it.
    model.status(taken: true, story: nil, error: nil, said: "plan my week", conversation: "mac:owner")
    model.status(taken: true, story: nil, error: nil, said: "not this chat", conversation: "cm1:owner")
    #expect(model.sending == ["plan my week"])
    #expect(model.working)
    model.status(taken: false, story: .some("› Read the calendar"), error: nil, said: "plan my week", conversation: "mac:owner")
    #expect(model.story == "› Read the calendar")
    model.status(taken: false, story: .some(nil), error: nil, said: "plan my week", conversation: "mac:owner")
    model.show(conversation: "mac:owner", title: "Mac", lines: [.you("plan my week", files: []), .kos("Done.")])
    #expect(model.sending.isEmpty)
    #expect(!model.working)
    // Its steps told once more as it closed: the chat has them already.
    model.status(taken: false, story: .some("› Read the calendar"), error: nil, said: "plan my week", conversation: "mac:owner")
    #expect(model.story == nil)
    #expect(!model.working)
    // Opened mid-turn: the words are in the chat already, so they are not shown twice.
    model.show(conversation: "mac:owner", title: "Mac", lines: [.you("plan my week", files: []), .kos("Done."), .you("and next week", files: [])])
    model.status(taken: true, story: nil, error: nil, said: "and next week", conversation: "mac:owner")
    #expect(model.sending.isEmpty)
    #expect(model.working)
  }

  @Test func theHeaderSaysWhyThereIsNoChatAsThePanelDoes() {
    let model = ChatModel()
    #expect(model.subtitle == "Not paired yet")
    model.paired = true
    #expect(model.subtitle == "Not connected")
    #expect(!model.usable)
    model.online = true
    model.silent = true
    #expect(model.subtitle == "This KOS cannot talk here yet")
    #expect(!model.usable)
    model.silent = false
    #expect(model.usable)
    #expect(model.subtitle == "A chat beside your apps")
    model.show(conversation: "mac:owner", title: "Q3 deck review", lines: [])
    #expect(model.subtitle == "Q3 deck review")
    model.silent = true
    model.reset()
    #expect(!model.silent)
  }

  @Test func readsARunningTurnsStoryIntoItsStepsAndWords() {
    let model = ChatModel()
    #expect(model.running.steps.isEmpty && model.running.words.isEmpty)
    model.say("tidy the deck")
    model.status(taken: false, story: .some("…half a line\n› Look at the screen\n› Click Format (failed)\n\nTrying the menu instead"), error: nil)
    #expect(model.running.steps == [.init(summary: "Look at the screen"), .init(summary: "Click Format", failed: true)])
    #expect(model.running.words == "Trying the menu instead")
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

  /// Words said while a turn runs get their own story: neither overwrites the other, and each sits under its own words.
  @Test func eachTurnKeepsItsOwnStoryUnderItsWords() {
    let model = ChatModel()
    model.show(conversation: "mac:owner", title: "Mac", lines: [.you("count the books", files: [])])
    model.status(taken: false, story: .some("› Run a query"), error: nil, said: "count the books", conversation: "mac:owner")
    model.say("and the shelves")
    model.status(taken: true, story: nil, error: nil, said: "and the shelves", conversation: "mac:owner")
    model.status(taken: false, story: .some("Noted, after this."), error: nil, said: "and the shelves", conversation: "mac:owner")
    model.status(taken: false, story: .some("› Run a query\n› Count rows"), error: nil, said: "count the books", conversation: "mac:owner")
    #expect(model.stories.map(\.said) == ["count the books", "and the shelves"])
    #expect(model.stories.first?.text == "› Run a query\n› Count rows")
    #expect(model.items.map(\.id) == ["l0", "t0", "s0", "t1"])
    // Its frames stay with it.
    let abc = Data("ABC".utf8).base64EncodedString()
    model.frame(4, image: abc, said: "count the books", conversation: "mac:owner")
    #expect(model.liveFrames(of: "count the books") == [4])
    #expect(model.liveFrames(of: "and the shelves").isEmpty)
    // The first is done; the second still runs, and the foot stays.
    model.status(taken: false, story: .some(nil), error: nil, said: "count the books", conversation: "mac:owner")
    #expect(model.stories.map(\.said) == ["and the shelves"])
    #expect(model.working)
    #expect(model.liveFrames.isEmpty)
  }

  /// A turn in another chat says nothing here: not its story, not its end, not its error.
  @Test func anotherChatsTurnIsNotDrawn() {
    let model = ChatModel()
    model.show(conversation: "mac:owner", title: "Mac", lines: [.you("look", files: [])])
    model.status(taken: false, story: .some("› Look"), error: nil, said: "look", conversation: "mac:owner")
    model.status(taken: false, story: .some("› Elsewhere"), error: nil, said: "other", conversation: "cm1:owner")
    model.status(taken: false, story: .some(nil), error: nil, said: "look", conversation: "cm1:owner")
    model.status(taken: false, story: nil, error: "halted", conversation: "cm1:owner")
    #expect(model.story == "› Look")
    #expect(model.working)
    #expect(model.error == nil)
  }
}
