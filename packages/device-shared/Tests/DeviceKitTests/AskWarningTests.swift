#if os(macOS)
import AppKit
import DeviceCore
import SwiftUI
import Testing

@testable import DeviceKit

/// The warning an ask's card gives before any yes when no turn waits on it (`detached`), drawn by `AskSummary`, which
/// both KOS for Mac's card and KOS for iPhone's sheet lay out: there for a detached ask, never for a secret's.
@MainActor
@Suite("An ask's detached warning")
struct AskWarningTests {
  /// The host's words for a schedule's ask (DETACHED_WORDS.unwaited in @kos/shared).
  static let unwaited = "Nothing is waiting on this; approving runs it now and the result goes to its chat."

  /// How tall the card's summary is drawn at a card's width: offscreen, the drawn views offer no accessibility tree to
  /// read, so the warning is seen by the room it takes.
  private func height(_ ask: ChatModel.Ask) -> CGFloat {
    NSHostingView(rootView: AskSummary(ask).frame(width: 420)).fittingSize.height
  }

  /// The same ask, with or without the host's warning.
  private func notify(detached: String? = nil) -> ChatModel.Ask {
    .init(id: "1", tool: "notify", title: "Message you: \u{201C}Rent is due tomorrow\u{201D}", risk: "Sends a message", detached: detached)
  }

  @Test func aDetachedAskIsWarnedOfBeforeAnyYes() {
    // A line of the warning's words and its padding, under the risk.
    #expect(height(notify(detached: Self.unwaited)) >= height(notify()) + 24)
  }

  @Test func anAskAfterOutsideTextSaysWhatWasRead() throws {
    // The host's line for an ask a tainted turn raised (taintLine in @kos/shared), decoded and drawn above the yes.
    let line = "After reading: an email from x@example.com"
    let json = #"{"id":"7","tool":"notify","title":"Message #general","risk":"Posts where others read","after":"After reading: an email from x@example.com"}"#
    let ask = ChatCalls.ask(try JSONDecoder().decode(ChatApproval.self, from: Data(json.utf8)), chat: nil)
    #expect(ask.after == line)
    let plain = ChatModel.Ask(id: ask.id, tool: ask.tool, title: ask.title, risk: ask.risk)
    #expect(height(ask) >= height(plain) + 24)
  }

  @Test func aSecretsAskAsTheHostSendsItIsNotWarned() throws {
    // The host never sends `detached` for a secret's ask: one whose turn has gone lapses, it never runs for nobody.
    let json = #"{"id":"9","tool":"secrets.fill","title":"Fill Visa on shop.example","risk":"Puts a card into a page","alwaysNote":"Secrets always ask","secret":{"handle":"visa","label":"Visa","fields":["number"],"origin":"https://shop.example"}}"#
    let ask = ChatCalls.ask(try JSONDecoder().decode(ChatApproval.self, from: Data(json.utf8)), chat: nil)
    #expect(ask.detached == nil)
    let warned = ChatModel.Ask(id: ask.id, tool: ask.tool, title: ask.title, risk: ask.risk, alwaysNote: ask.alwaysNote, secret: ask.secret, detached: Self.unwaited)
    #expect(height(ask) + 24 <= height(warned))
  }

  @Test func theHostsWordsReachTheCard() throws {
    let json = #"{"id":"7","tool":"cron.schedule","title":"Schedule “Water the plants”","detached":"\#(Self.unwaited)"}"#
    let ask = ChatCalls.ask(try JSONDecoder().decode(ChatApproval.self, from: Data(json.utf8)), chat: "c1")
    #expect(ask.detached == Self.unwaited)
  }
}
#endif
