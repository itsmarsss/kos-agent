import DeviceCore
import SwiftUI
import Testing

#if os(macOS)
import AppKit
#endif

@testable import DeviceKit

/// Typed blocks as KOS for Mac and the phone read and draw them, to the grammar in docs/blocks.md.
@MainActor
@Suite("Typed blocks")
struct KOSBlockTests {
  private func lines(_ text: String) -> [String] { text.components(separatedBy: "\n") }

  private func block(_ kind: String, _ text: String) throws -> KOSBlock {
    try #require(KOSBlock.parse(info: "kos:\(kind)", lines: lines(text)))
  }

  @Test func readsTheHeaderTheRuleAndTheBody() throws {
    let email = try block("email", "to: sam@example.com\nTo: amy@example.com\ncc:\nsubject: Saturday at 4\n---\n\nHi Sam,\n\n---\nStill on?\n")
    #expect(email.kind == "email")
    #expect(email.values("to") == ["sam@example.com", "amy@example.com"])
    #expect(email.values("cc").isEmpty)
    #expect(email.body == "Hi Sam,\n\n---\nStill on?")
  }

  @Test func takesEitherHalfEmptyAndRefusesAMalformedHeader() throws {
    #expect(try block("command", "---\nls -la") == KOSBlock(kind: "command", fields: [], body: "ls -la"))
    #expect(try block("contact", "name: Sam") == KOSBlock(kind: "contact", fields: [.init("name", "Sam")], body: ""))
    #expect(KOSBlock.parse(info: "kos:email", lines: lines("Hi Sam,\nsee you")) == nil)
    #expect(KOSBlock.parse(info: "ts", lines: ["x"]) == nil)
    #expect(KOSBlock.parse(info: "kos:", lines: ["---"]) == nil)
    #expect(KOSBlock.parse(info: "kos:9lives", lines: ["---"]) == nil)
  }

  @Test func aLongerFenceHoldsAShorterOneAndAnOpenOneRunsToTheEnd() {
    let nested = lines("````kos:card\ntitle: Snippet\n---\n```ts\nx\n```\n````\nafter")
    let fence = KOSBlock.fence(nested, at: 0)
    #expect(fence?.ticks == 4 && fence?.next == 7 && fence?.closed == true)
    #expect(fence?.body == ["title: Snippet", "---", "```ts", "x", "```"])
    #expect(KOSBlock.fence(lines("```kos:email\nto: a"), at: 0)?.closed == false)
    #expect(KOSBlock.fence(["say ```this```"], at: 0) == nil)
  }

  @Test func takesTheOpenersIndentOffEachLineAndNoMore() {
    let fence = KOSBlock.fence(lines("   ```kos:email\n   to: a@x.com\n   ---\n   Hi,\n     indented\n flush\n   ```"), at: 0)
    #expect(fence?.body == ["to: a@x.com", "---", "Hi,", "  indented", "flush"])
  }

  @Test func takesAnyInfoStringAsCommonMarkDoesTheFirstWordItsLanguage() throws {
    let titled = try #require(KOSBlock.fence(lines("```ts title=\"x.ts\"\nconst a = 1;\n```\nafter"), at: 0))
    #expect(titled.info == "ts title=\"x.ts\"" && titled.lang == "ts" && titled.next == 3 && titled.closed)
    #expect(KOSBlock.fence(lines("```js {1,3}\nx\n```"), at: 0)?.next == 3)
    #expect(KOSBlock.parse(info: "kos:email draft", lines: ["to: a@x.com"])?.kind == "email")
    // The closing fence closes it; it never opens another that eats the reply.
    #expect(ChatBlock.blocks("```ts title=\"a.ts\"\nconst a = 1;\n```\n\nafter") == [.code("const a = 1;"), .paragraph("after")])
    #expect(ChatBlock.blocks("```js {1,3}\nx\n```\nafter") == [.code("x"), .paragraph("after")])
  }

  @Test func opensOnlyHttpsWithNoUserAndNamesTheRealHost() throws {
    let links = { (actions: [String]) in try self.block("card", actions.map { "action: \($0)" }.joined(separator: "\n")).layout.links }
    #expect(try links(["open http://example.com", "open https://bank.com@evil.com Bank", "open javascript:alert(1)", "open https://user:pw@x.com"]).isEmpty)
    let link = try #require(try links(["open https://xn--pple-43d.com/login Apple"]).first)
    #expect(link.label == "Apple" && link.host == "xn--pple-43d.com" && link.url.absoluteString == "https://xn--pple-43d.com/login")
    #expect(try links(["open https://x.com \u{202E}moc.knab\u{202C}"]).first?.label == "moc.knab")
    #expect(try links(["open\thttps://example.com:8443/a\tAdmin"]).first.map { "\($0.label) \($0.host)" } == "Admin example.com:8443")
    // A host in another script is shown as it is reached, or is no link at all; never as the look-alike.
    #expect(try links(["open https://\u{0430}pple.com"]).allSatisfy { $0.host == "xn--pple-43d.com" })
  }

  @Test func namesAChannelAsItselfAndSaysWhatABlockIs() throws {
    #expect(try block("message", "to: Amy\nchannel: imessage").layout.rows.map(\.values) == [["Amy"], ["iMessage"]])
    #expect(try block("message", "channel: SMS").plain == "Draft message\nVia: SMS")
    #expect(try block("email", "to: Sam\n---\nhi").spoken == "a draft email to Sam")
    #expect(try block("event", "title: Dinner").spoken == "an event, Dinner")
    #expect(try block("checklist", "---\n- [ ] x").spoken == "a checklist")
    #expect(try block("card", "title: Plan").spoken == "a note, Plan")
  }

  @Test func drawsABlockInAListItemWithTheIndentOffAndOneInAQuoteAsWords() {
    let text = "1. Send this:\n\n   ```kos:email\n   to: a@x.com\n   ---\n   Hi,\n     indented\n   ```\n2. Done\n\n> ```kos:email\n> to: a@x.com\n> ```"
    let blocks = ChatBlock.blocks(text)
    guard case .list(_, _, let items) = blocks.first else { Issue.record("no list"); return }
    #expect(items.first?.last == .block(KOSBlock(kind: "email", fields: [.init("to", "a@x.com")], body: "Hi,\n  indented"), closed: true))
    #expect(blocks.last == .quote("```kos:email\nto: a@x.com\n```"))
  }

  @Test func laysOutRowsInTheKindsOrderWithOnlySafeLinks() throws {
    let event = try block("event", "where: Nopa\nwhen: <t:2026-11-21T19:30:f>\ntitle: Dinner\nmood: fancy\naction: open https://nopa.com Menu\naction: rm -rf /")
    let layout = event.layout
    #expect(layout.title == "Dinner")
    #expect(layout.rows.map(\.label) == ["When", "Where", "Mood"])
    #expect(layout.links.map(\.label) == ["Menu"] && layout.links.map(\.url.absoluteString) == ["https://nopa.com"])
    #expect(try block("recipe", "title: Soup").layout.kind.label == "Recipe")
    #expect(BlockKind.named("follow-up").label == "Follow up")
  }

  @Test func saysABlockInPlainWordsAndCopiesADraftsBody() throws {
    let email = try block("email", "to: sam@example.com\nsubject: Saturday at 4\n---\nHi Sam,\nStill on?")
    #expect(email.plain == "Draft email\nTo: sam@example.com\nSubject: Saturday at 4\n\nHi Sam,\nStill on?")
    #expect(email.copyText == "Hi Sam,\nStill on?")
    #expect(try block("card", "title: Plan\nbudget: $40\n---\nGo early.").plain == "Plan\nBudget: $40\n\nGo early.")
    #expect(try block("event", "title: Dinner\nwhen: Sat").copyText == "Event: Dinner\nWhen: Sat")
  }

  @Test func opensADraftInMailAndAnAddressOnAMap() throws {
    let email = try block("email", "to: sam@example.com\ncc: lee@example.com\nsubject: Sat at 4\n---\nHi,\nok?")
    #expect(email.mailto?.absoluteString == "mailto:sam%40example.com?cc=lee%40example.com&subject=Sat%20at%204&body=Hi%2C%0Aok%3F")
    #expect(try block("address", "name: Nopa\n---\n560 Divisadero St\nSan Francisco").map?.absoluteString
      == "https://www.google.com/maps/search/?api=1&query=Nopa%2C%20560%20Divisadero%20St%2C%20San%20Francisco")
  }

  @Test func readsChecklistsStepsAndDiffs() throws {
    let list = try block("checklist", "---\n- [ ] milk\n- [x] eggs\nat the shop\n* [X] bread").checklist
    #expect(list.map(\.text) == ["milk", "eggs", "at the shop", "bread"])
    #expect(list.map(\.done) == [false, true, nil, true])
    #expect(try block("steps", "---\n1. Open\n2) Click\n- Done").steps == ["Open", "Click", "Done"])
    #expect(["@@ -1 +1 @@", "+a", "-b", " c", "+++ b/x"].map(DiffLine.init) == [.hunk, .add, .del, .same, .same])
  }

  @Test func theMarkdownDrawsABlockAsItsKindAndAMalformedOneAsCode() {
    let text = "Drafted:\n\n```kos:message\nto: Amy\nchannel: imessage\n---\nRunning late\n```\n```kos:email\nHi Sam\n```\n```kos:message\nto: Sam\n---\nOn my"
    #expect(ChatBlock.blocks(text) == [
      .paragraph("Drafted:"),
      .block(KOSBlock(kind: "message", fields: [.init("to", "Amy"), .init("channel", "imessage")], body: "Running late"), closed: true),
      .code("Hi Sam"),
      // A block still arriving is drawn, marked open, so it offers Copy alone.
      .block(KOSBlock(kind: "message", fields: [.init("to", "Sam")], body: "On my"), closed: false),
    ])
  }

  #if os(macOS)
  static let reply = """
    Here's the draft for Sam.

    ```kos:email
    to: sam.okonkwo-richardson@verylongcompanyname.example.com
    to: amy@example.com
    cc: lee@example.com
    subject: Saturday at 4, and whether we should push the reservation to 5 instead
    ---
    Hi Sam,

    Still on for Saturday at 4? I booked the table at Nopa under my name.

    Kenny
    ```

    ```kos:message
    to: Amy
    channel: imessage
    ---
    Running 10 late, save me a seat!
    ```

    ```kos:event
    title: Dinner at Nopa
    when: <t:2026-11-21T19:30:f>
    end: <t:2026-11-21T21:30:t>
    where: 560 Divisadero St, San Francisco
    ---
    Table for 4 under Kenny.
    ```

    ```kos:checklist
    title: Before the trip
    ---
    - [x] Book the flight
    - [ ] Pack the charger
    - [ ] Ask Lee to water the plants while we are away for the whole long weekend
    ```

    ```kos:card
    title: Laptop pick
    price: $1,299
    battery: 18 hours
    action: open https://example.com/laptop Store page
    ---
    The **Air** wins on weight; the Pro only if you edit video.
    ```

    ```kos:command
    cwd: ~/kos
    ---
    pnpm -F @kos/ui build && pnpm exec tsc -b
    ```
    """

  /// The blocks at the Mac chat window's column (380 wide, 16 a side) and a 390 phone's, in both themes; with
  /// KOS_SNAPSHOT_DIR set each is written there as `blocks-<width>-<theme>.png`.
  @Test(arguments: [348.0, 358.0])
  func rendersAtAChatsWidth(width: Double) throws {
    for (theme, appearance) in [("dark", NSAppearance.Name.darkAqua), ("light", .aqua)] {
      let view = ChatMarkdown(Self.reply).padding(16).frame(width: width + 32).background(Theme.bg)
      let host = NSHostingView(rootView: view)
      host.frame = CGRect(origin: .zero, size: host.fittingSize)
      let window = NSWindow(contentRect: host.frame, styleMask: .borderless, backing: .buffered, defer: false)
      window.appearance = NSAppearance(named: appearance)
      window.contentView = host
      host.layoutSubtreeIfNeeded()
      #expect(host.fittingSize.width <= width + 32.5, "the blocks are wider than the column")
      if let dir = ProcessInfo.processInfo.environment["KOS_SNAPSHOT_DIR"] {
        let rep = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: rep)
        let png = try #require(rep.representation(using: .png, properties: [:]))
        try png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("blocks-\(Int(width))-\(theme).png"))
      }
    }
  }
  #endif
}
