import CoreGraphics
import DeviceCore
import DeviceKit
import Foundation
import Testing

@testable import DeviceUI

private func live(paused: Bool = false, step: String? = nil, waiting: Bool = false) throws -> LiveSession {
  var sessions = Sessions()
  try sessions.ask("s1", from: "kos")
  _ = try sessions.grant("s1", task: "Fill in the form", requester: "School", minutes: 15, space: Space(display: Rect(x: 0, y: 0, width: 1512, height: 982)), now: Date())
  if paused { _ = sessions.pause() }
  _ = sessions.status("s1", from: "kos", step: step, waiting: waiting)
  return try #require(sessions.live)
}

@MainActor
@Suite("The menu bar's turn")
struct MenuTurnTests {
  @Test func idleWithNothingGoing() {
    #expect(MenuTurn.of(session: nil, chat: ChatModel()) == .idle)
    #expect(MenuTurn.idle.title == nil)
  }

  @Test func workingSaysTheStepCutToFit() throws {
    let turn = MenuTurn.of(session: try live(step: "Open the engagement form for the quiz (click)"), chat: ChatModel())
    #expect(turn.state == .working && turn.session)
    #expect(turn.title == "Open the engagement for…")
    #expect(turn.title!.count == MenuTurn.titleLength)
    #expect(turn.detail == "Open the engagement form for the quiz (click)")
  }

  @Test func theWindowsTurnWorksWithNoSession() {
    let chat = ChatModel()
    chat.show(conversation: "mac:owner", title: "Mac", lines: [])
    chat.say("count the books")
    chat.status(taken: false, story: .some("› Run a query"), error: nil)
    let turn = MenuTurn.of(session: nil, chat: chat)
    #expect(turn == MenuTurn(state: .working, step: "Run a query"))
    chat.status(taken: false, story: .some("› Run a query (done)"), error: nil)
    #expect(MenuTurn.of(session: nil, chat: chat).title == "Thinking")
  }

  @Test func waitingOnTheOwnerOffersTheTopAsk() throws {
    let chat = ChatModel()
    chat.show(conversation: "mac:owner", title: "Mac", lines: [])
    chat.ask(.init(id: "a1", tool: "computer.act", summary: "Click Submit", chat: "mac:owner"))
    chat.ask(.init(id: "a2", tool: "files.write", chat: "mac:owner"))
    let turn = MenuTurn.of(session: try live(step: "Click Submit (click)"), chat: chat)
    #expect(turn.state == .waiting && turn.ask?.id == "a1")
    #expect(turn.title == "Waiting on you")
    #expect(turn.detail == "Click Submit")
    // The session's chat waits, though the window shows another.
    #expect(MenuTurn.of(session: try live(waiting: true), chat: ChatModel()).state == .waiting)
  }

  @Test func keepsWhatIsTypedOutOfTheMenuBar() throws {
    #expect(MenuTurn.of(session: try live(step: "Type “hunter2”"), chat: ChatModel()).title == "Typing")
    let turn = MenuTurn.of(session: try live(step: "Sign in (type “sam@example.com”, press Return)"), chat: ChatModel())
    #expect(turn.detail == "Sign in (type …, press Return)")
  }

  /// The badge is the session's chat's: its ask is the one Approve decides, not another the window shows.
  @Test func decidesTheAskOfTheChatThatWaits() throws {
    let chat = ChatModel()
    chat.show(conversation: "mac:owner", title: "Mac", lines: [])
    chat.ask(.init(id: "a1", tool: "files.write", chat: "mac:owner"))
    // The session is another chat's: nothing here to decide for it.
    var other = try live(waiting: true)
    #expect(other.conversation == nil)
    #expect(MenuTurn.of(session: other, chat: chat).ask == nil)
    var sessions = Sessions()
    try sessions.ask("s2", from: "kos")
    other = try sessions.grant("s2", task: "t", requester: "r", conversation: "mac:owner", minutes: 5, space: Space(display: Rect(x: 0, y: 0, width: 10, height: 10)), now: Date())
    _ = sessions.status("s2", from: "kos", step: nil, waiting: true)
    #expect(MenuTurn.of(session: try #require(sessions.live), chat: chat).ask?.id == "a1")
  }

  @Test func pausedWhileTheOwnerHasTheMac() throws {
    let turn = MenuTurn.of(session: try live(paused: true, waiting: true), kos: "home.local", chat: ChatModel())
    #expect(turn.state == .paused && turn.title == nil)
    #expect(turn.detail == "Fill in the form, for home.local")
  }
}

@Suite("The chat window during a session")
struct ChatAsideTests {
  @Test func stepsAsideWhenItCoversTheTargetAndComesBackWhenNeeded() {
    var aside = ChatAside()
    #expect(aside.take(.live(open: true, covers: false)) == .stay)
    #expect(aside.take(.live(open: false, covers: true)) == .stay)
    #expect(aside.take(.needsOwner) == .stay)
    #expect(aside.take(.live(open: true, covers: true)) == .hide)
    #expect(aside.take(.needsOwner) == .show(clear: true))
    // Moved clear for the owner, it goes back where it stood once the session ends.
    #expect(aside.take(.ended) == .restore)
    #expect(aside.take(.live(open: true, covers: true)) == .hide)
    #expect(aside.take(.ended) == .show(clear: false))
    #expect(aside.take(.ended) == .stay)
    // Opened by the owner meanwhile, it is theirs: nothing to bring back.
    #expect(aside.take(.live(open: true, covers: true)) == .hide)
    #expect(aside.take(.opened) == .stay)
    #expect(aside.take(.ended) == .stay)
  }

  @Test func staysWhileTheOwnerTypesInIt() {
    var aside = ChatAside()
    #expect(aside.take(.live(open: true, covers: true, typing: true)) == .stay)
    #expect(aside.take(.needsOwner) == .stay)
    #expect(aside.take(.ended) == .stay)
  }

  @Test func standsClearOfAWindowKOSWorksIn() throws {
    let screen = CGRect(x: 0, y: 0, width: 1512, height: 944)
    let target = CGRect(x: 300, y: 200, width: 800, height: 600)
    let window = CGRect(x: 900, y: 300, width: 380, height: 560)
    #expect(ChatPlacement.covers(window, target: target))
    let to = try #require(ChatPlacement.clear(of: target, window: window, in: screen))
    let placed = CGRect(origin: to, size: window.size)
    #expect(!placed.intersects(target) && screen.contains(placed))
    // The nearest clear side: right of the target, at the same height.
    #expect(to == CGPoint(x: 1112, y: 300))
  }

  @Test func findsNoRoomBesideTheWholeScreen() {
    let screen = CGRect(x: 0, y: 0, width: 1512, height: 944)
    let window = CGRect(x: 1100, y: 360, width: 380, height: 560)
    #expect(ChatPlacement.clear(of: screen, window: window, in: screen) == nil)
    // On another screen, the corner it had on its own.
    let other = CGRect(x: 1512, y: 0, width: 1920, height: 1080)
    let to = ChatPlacement.onAnother(other, window: window, from: screen)
    #expect(to == CGPoint(x: 1512 + 1920 - 12 - 380, y: 1080 - 12 - 560))
  }
}
