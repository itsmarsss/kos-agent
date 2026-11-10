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
    model.send = { text, _ in sent.append(text) }
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

  /// A command is never in the chat's words: taken, it is never on its way, so its answer ends the wait.
  @Test func aCommandTakenNeverWaitsOnItsOwnWords() {
    for command in ["/stop", "/clear", "/new", "/switch 2"] {
      let model = ChatModel()
      model.show(conversation: "mac:owner", title: "Mac", lines: [.you("hi", files: []), .kos("Hello.")])
      model.say(command)
      model.status(taken: true, story: nil, error: nil, said: command, conversation: "mac:owner", command: true)
      #expect(model.sending.isEmpty)
      model.show(conversation: "mac:owner", title: "Mac", lines: [], notice: (text: "Done.", from: nil, waiting: false))
      #expect(!model.working)
    }
  }

  /// Words that start with a slash but name no command are a message: on their way, told as they go, and given back if never taken.
  @Test func wordsThatNameNoCommandAreAMessage() {
    let said = "/etc/hosts is broken"
    let model = ChatModel()
    model.show(conversation: "mac:owner", title: "Mac", lines: [])
    model.say(said)
    #expect(model.sending == [said])
    model.status(taken: true, story: nil, error: nil, said: said, conversation: "mac:owner", command: false)
    #expect(model.sending == [said])
    model.status(taken: false, story: .some("› Read the file"), error: nil, said: said, conversation: "mac:owner")
    #expect(model.story == "› Read the file")
    model.giveBack("KOS did not take that.")
    #expect(model.sending.isEmpty)
    #expect(model.draft == said)
    // A command KOS knows by another name goes once KOS says it is one.
    model.say("/cancel")
    model.status(taken: true, story: nil, error: nil, said: "/cancel", conversation: "mac:owner", command: true)
    #expect(model.sending.isEmpty)
  }

  /// Words sent while no chat was shown wait for the first one made until it has them, and come back if never taken.
  @Test func wordsSentFromNoneWaitForTheFirstChat() {
    let model = ChatModel()
    model.say("/new")
    model.say("find the deck")
    model.show(conversation: "mac:owner", title: "New conversation", lines: [], notice: (text: "Started 'New conversation'", from: nil, waiting: false))
    #expect(model.sending == ["find the deck"])
    #expect(model.working)
    model.show(conversation: "mac:owner", title: "find the deck", lines: [.you("find the deck", files: [])])
    #expect(model.sending.isEmpty)
    model.say("and the notes")
    model.show(conversation: "cm1:owner", title: "Trip", lines: [])
    #expect(model.sending.isEmpty)
  }

  /// Words sent from none wait for the chat KOS took them in, though none is shown again on the way.
  @Test func wordsSentFromNoneWaitForTheChatTheyWentIn() {
    let model = ChatModel()
    model.show(conversation: nil, title: "Mac", lines: [])
    model.say("hi")
    model.status(taken: true, story: nil, error: nil, said: "hi", conversation: "z:owner")
    model.show(conversation: nil, title: "Mac", lines: [])
    model.show(conversation: "z:owner", title: "New conversation", lines: [])
    #expect(model.sending == ["hi"])
    #expect(model.working)
  }

  /// Words sent from none are not on their way to a chat the owner moved to mid-turn: it does not spin on them.
  @Test func wordsSentFromNoneLeaveAChatMovedToMidTurn() {
    let model = ChatModel()
    model.show(conversation: nil, title: "Mac", lines: [])
    model.say("hi")
    model.status(taken: true, story: nil, error: nil, said: "hi", conversation: "z:owner")
    model.show(conversation: "w:owner", title: "Trip", lines: [.you("a", files: []), .kos("b")])
    #expect(model.sending.isEmpty)
    #expect(!model.working)
  }

  /// While the window shows no chat, the turn in the chat it is about to show is told: its story shows before the chat does.
  @Test func theFirstTurnFromNoneIsTold() {
    let model = ChatModel()
    model.show(conversation: nil, title: "Mac", lines: [])
    model.say("tidy the deck")
    model.status(taken: true, story: nil, error: nil, said: "tidy the deck", conversation: "mac:owner")
    model.status(taken: false, story: .some("› Look at the screen"), error: nil, said: "tidy the deck", conversation: "mac:owner")
    #expect(model.story == "› Look at the screen")
    // Another chat's turn is still not this one's.
    model.status(taken: false, story: .some("› Elsewhere"), error: nil, said: "other", conversation: "cm1:owner")
    #expect(model.stories.map(\.text) == ["› Look at the screen"])
    model.show(conversation: "mac:owner", title: "tidy the deck", lines: [.you("tidy the deck", files: [])])
    #expect(model.story == "› Look at the screen")
    #expect(model.working)
  }

  /// Taken before its chat was made, the first turn is told by the words it is about.
  @Test func theFirstTurnIsToldByItsWordsWhenTakenBeforeItsChat() {
    let model = ChatModel()
    model.say("tidy the deck")
    model.status(taken: true, story: nil, error: nil, said: "tidy the deck", conversation: nil)
    model.status(taken: false, story: .some("› Look"), error: nil, said: "tidy the deck", conversation: "mac:owner")
    #expect(model.story == "› Look")
  }

  /// While the window shows no chat, the first turn's pictures draw as it goes and stay once its chat is shown.
  @Test func theFirstTurnFromNoneShowsItsPictures() {
    let model = ChatModel()
    let abc = Data("ABC".utf8).base64EncodedString()
    model.show(conversation: nil, title: "Mac", lines: [])
    model.say("tidy the deck")
    model.status(taken: true, story: nil, error: nil, said: "tidy the deck", conversation: "mac:owner")
    model.frame(3, image: abc, said: "tidy the deck", conversation: "mac:owner")
    // Another chat's is still not this one's.
    model.frame(4, image: abc, said: "other", conversation: "cm1:owner")
    #expect(model.liveFrames(of: "tidy the deck") == [3])
    #expect(model.liveFrames == [3])
    model.show(conversation: "mac:owner", title: "tidy the deck", lines: [.you("tidy the deck", files: [])])
    #expect(model.picturesOf([3]).map(\.id) == [3])
    #expect(model.liveFrames == [3])
  }

  /// A KOS from before taken words said whether they were a command took any starting with "/" as one.
  @Test func anOlderKOSTakesSlashWordsAsCommands() {
    let model = ChatModel()
    model.show(conversation: "mac:owner", title: "Mac", lines: [])
    model.say("/cancel")
    model.status(taken: true, story: nil, error: nil, said: "/cancel", conversation: "mac:owner")
    #expect(model.sending.isEmpty)
    model.say("hello")
    model.status(taken: true, story: nil, error: nil, said: "hello", conversation: "mac:owner")
    #expect(model.sending == ["hello"])
  }

  /// The first chat, made from none by /new, starts afresh and leaves the window ready for the next words.
  @Test func aChatMadeFromNoneStartsAfresh() {
    let model = ChatModel()
    model.show(conversation: nil, title: "Mac", lines: [], notice: (text: "Nothing is running.", from: nil, waiting: false))
    model.say("/new")
    model.status(taken: true, story: nil, error: nil, said: "/new", conversation: nil, command: true)
    model.show(conversation: "mac:owner", title: "New conversation", lines: [], notice: (text: "Started 'New conversation'", from: nil, waiting: false))
    #expect(model.conversation == "mac:owner")
    #expect(!model.working)
    #expect(model.notices.map(\.text) == ["Started 'New conversation'"])
    model.say("next")
    model.status(taken: true, story: nil, error: nil, said: "next", conversation: "mac:owner")
    #expect(model.sending == ["next"])
    #expect(model.working)
  }

  /// An ask made while the window showed no chat stays once its chat is shown; another chat's goes.
  @Test func anAskMadeBeforeItsChatIsShownStays() {
    let model = ChatModel()
    model.ask(.init(id: "a1", tool: "computer.act", chat: "mac:owner"))
    model.show(conversation: "mac:owner", title: "Mac", lines: [.you("tidy", files: [])], notice: (text: "Waiting on you", from: nil, waiting: true))
    #expect(model.asks.map(\.id) == ["a1"])
    model.ask(.init(id: "a2", tool: "computer.act", chat: "cm1:owner"))
    #expect(model.asks.map(\.id) == ["a1"])
    model.show(conversation: "cm1:owner", title: "Trip", lines: [])
    #expect(model.asks.isEmpty)
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

  /// A session asked for on the owner's screen holds the turn on them: the foot waits, with no clock, until it is answered.
  @Test func aSessionAskedOnTheScreenWaitsOnTheOwner() {
    let model = ChatModel()
    model.show(conversation: "mac:owner", title: "Mac", lines: [.you("tidy the deck", files: [])])
    model.status(taken: false, story: .some("› Use Studio MacBook: Keynote"), error: nil, said: "tidy the deck", conversation: "mac:owner")
    #expect(model.footLive)
    model.consent = .init(task: "Tidy the deck", until: Date().addingTimeInterval(60))
    #expect(model.foot == "Waiting on you")
    #expect(!model.footLive)
    #expect(model.busy)
    model.consent = nil
    // KOS says so too, before the Mac's own prompt is known here, and the wait ends with the turn.
    model.status(taken: false, story: .some("› Use Studio MacBook: Keynote"), error: nil, said: "tidy the deck", conversation: "mac:owner", waiting: .consent)
    #expect(model.foot == "Waiting on you")
    model.status(taken: false, story: .some(nil), error: nil, said: "tidy the deck", conversation: "mac:owner", waiting: .consent)
    #expect(model.waiting == nil)
    #expect(model.foot == nil)
    #expect(!model.busy)
  }

  /// The owner took the Mac over: the chat says they have it, without a clock, and waits for it back.
  @Test func aTurnHeldByTheOwnerSaysTheyHaveControl() {
    let model = ChatModel()
    model.show(conversation: "mac:owner", title: "Mac", lines: [.you("fill the form", files: [])])
    model.status(taken: false, story: .some("› Click Name"), error: nil, said: "fill the form", conversation: "mac:owner")
    model.session = .working
    #expect(!model.heldByOwner)
    model.session = .paused
    #expect(model.heldByOwner)
    #expect(model.foot == "Paused, you have control")
    #expect(!model.footLive)
    model.session = .working
    model.status(taken: false, story: .some("› Click Name"), error: nil, said: "fill the form", conversation: "mac:owner", held: true)
    #expect(model.heldByOwner)
    // A held turn with nothing running locally still shows, and a session alone is something to stop.
    model.status(taken: false, story: .some(nil), error: nil, said: "fill the form", conversation: "mac:owner")
    #expect(!model.held)
    #expect(model.busy)
    var stopped = 0
    var handed = 0
    model.stop = { stopped += 1 }
    model.handBack = { handed += 1 }
    model.session = .paused
    #expect(model.foot == "Paused, you have control")
    model.handBack()
    model.stop()
    #expect(handed == 1 && stopped == 1)
  }

  /// The box's button stops whatever this chat has going: a turn, a session, an ask for one; and only then.
  @Test func theBoxStopsWhileSomethingGoes() {
    let model = ChatModel()
    model.show(conversation: "mac:owner", title: "Mac", lines: [])
    #expect(!model.busy)
    model.say("look")
    #expect(model.busy)
    model.status(taken: false, story: .some(nil), error: nil)
    #expect(!model.busy)
    model.session = .working
    #expect(model.busy)
    model.session = nil
    model.consent = .init(task: "Look", until: Date())
    #expect(model.busy)
  }

  /// What the owner selected goes once, with their next words and not with a command, and is not offered again until they select something else.
  @Test func aSelectionGoesOnceWithTheNextWords() {
    let model = ChatModel()
    var sent: [(String, ChatModel.Quote?)] = []
    model.send = { sent.append(($0, $1)) }
    let teh = ChatModel.Quote(text: "teh cat", from: "Notes: Draft")
    model.selected(teh)
    #expect(model.quote == teh)
    model.say("/new")
    #expect(sent.last?.1 == nil)
    #expect(model.quote == teh)
    model.say("fix the typo")
    #expect(sent.last?.1 == teh)
    #expect(model.quote == nil)
    // Read afresh: the same words are not offered again, other words are.
    model.selected(teh)
    #expect(model.quote == nil)
    model.selected(.init(text: "the dog", from: "Notes: Draft"))
    #expect(model.quote?.text == "the dog")
    model.putQuoteAside()
    model.selected(.init(text: "the dog", from: "Notes: Draft"))
    #expect(model.quote == nil)
    model.selected(nil)
    #expect(model.quote == nil)
  }

  /// An ask that times out counts down to it, as the prompt on the screen does.
  @Test func anAskCountsDownToItsTimeout() {
    let now = Date(timeIntervalSince1970: 1_000)
    #expect(secondsLeft(until: now.addingTimeInterval(41.2), now: now) == "42s")
    #expect(secondsLeft(until: now.addingTimeInterval(125), now: now) == "2m 05s")
    #expect(secondsLeft(until: now.addingTimeInterval(-3), now: now) == "0s")
  }
}
