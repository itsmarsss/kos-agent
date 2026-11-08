import SwiftUI
import Testing

@testable import DeviceUI

/// KOS's words as the window reads them: the side panel's markdown.
@Suite("Chat markdown")
struct ChatMarkdownTests {
  @Test func readsTheBlocksAChatUses() {
    let text = "# Deck\n\nIt is **done**.\nAlmost.\n\n- one\n  - under one\n- two\n\n2. second\n3. third\n\n> quoted\n> more\n\n-# as of today\n\n```\nlet x = 1\n```\n| a | b |\n| 1 | 2 |"
    #expect(ChatBlock.blocks(text) == [
      .heading(1, "Deck"),
      .paragraph("It is **done**.\nAlmost."),
      .list(ordered: false, start: 1, items: [[.paragraph("one"), .list(ordered: false, start: 1, items: [[.paragraph("under one")]])], [.paragraph("two")]]),
      .list(ordered: true, start: 2, items: [[.paragraph("second")], [.paragraph("third")]]),
      .quote("quoted\nmore"),
      .small("as of today"),
      .code("let x = 1"),
      .code("| a | b |\n| 1 | 2 |"),
    ])
  }

  @Test func readsATableWithItsHeadLineAsATable() {
    #expect(ChatBlock.blocks("| Slide | Missing |\n| --- | ---: |\n| 4 | a \\| b |") == [
      .table(head: ["Slide", "Missing"], align: [.leading, .trailing], rows: [["4", "a | b"]]),
    ])
  }

  @Test func linksOnlyToTheWebAndMailAndNamesReferences() {
    let styled = chatInline("see [docs](https://kos.example/a), [bad](javascript:alert(1)) and https://example.com, or @page:[Budget]")
    let links = styled.runs.compactMap(\.link).map(\.absoluteString)
    #expect(links == ["https://kos.example/a", "https://example.com"])
    #expect(String(styled.characters).contains("Budget"))
    #expect(!String(styled.characters).contains("@page"))
  }

  @Test func drawsATimeAsItsWordsWithTheFullDateOnHover() {
    let soon = Int(Date().timeIntervalSince1970) + 3 * 3600
    let styled = chatInline("Due <t:\(soon):R>, not `<t:\(soon):R>`.")
    let words = String(styled.characters)
    #expect(words.contains("in 3 hours"))
    #expect(words.contains("`") == false && words.contains("<t:\(soon):R>"))
    #expect(styled.runs.compactMap(\.link).isEmpty)
    // One that does not parse stays as typed.
    #expect(String(chatInline("at <t:never:R>").characters) == "at <t:never:R>")
    #expect(ChatTime.help(for: "nothing to say") == nil)
    #expect(ChatTime.help(for: "Due <t:\(soon):R>")?.contains("\nat ") == true)
  }

  @Test func saysNothingOnHoverForATimeInACodeSpan() {
    let soon = Int(Date().timeIntervalSince1970) + 3 * 3600
    let later = soon + 86_400
    #expect(timesHelpText("Written `<t:\(soon):R>` as is") == nil)
    let help = timesHelpText("Due <t:\(later):R>, written `<t:\(soon):R>`")
    #expect(help == ChatTime.help(for: "<t:\(later):R>"))
  }

  @Test func readsATimeAsWrittenAndSaysItInFull() throws {
    let toronto = try #require(TimeZone(identifier: "America/Toronto"))
    let late = Date(timeIntervalSince1970: 1_795_237_140) // 2026-11-21 04:59 UTC
    #expect(ChatTime.instant("2026-11-20T23:59", zone: toronto) == late)
    #expect(ChatTime.instant("2026-11-21T04:59Z") == late)
    #expect(ChatTime.instant("2026-11-21T06:59+02:00") == late)
    #expect(ChatTime.instant("1795237140") == late)
    #expect(ChatTime.instant("2026-13-01") == nil)
    #expect(ChatTime.words(late, style: "t", zone: toronto) == "23:59")
    #expect(ChatTime.words(late, style: "D", zone: toronto) == "20 November 2026")
    let us = ChatTime.card(late, locale: Locale(identifier: "en_US"), zone: toronto)
    #expect(us.date == "Friday, November 20, 2026")
    #expect(us.time.replacingOccurrences(of: "\u{202F}", with: " ") == "at 11:59 PM")
    #expect(ChatTime.card(late, locale: Locale(identifier: "en_GB"), zone: toronto).time == "at 23:59")
  }
}

