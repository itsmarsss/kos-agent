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

  @Test func readsCodeSpansAsCommonMarkDoes() {
    let soon = Int(Date().timeIntervalSince1970) + 3 * 3600
    let token = "<t:\(soon):R>"
    // Same-length runs open and close a span; a double run holds a single backtick.
    #expect(codeSpans("a `x` b").map(\.code) == [false, true, false])
    #expect(codeSpans("``a ` \(token)`` b").map(\.text) == ["``a ` \(token)``", " b"])
    #expect(String(chatInline("``a ` \(token)``").characters).contains(token))
    // A run nothing closes is literal, and the line goes on as words.
    #expect(codeSpans("it's a ` mark, due \(token)").map(\.code) == [false])
    let stray = String(chatInline("it's a ` mark, due \(token)").characters)
    #expect(stray.contains("in 3 hours") && !stray.contains(token))
    #expect(timesHelpText("it's a ` mark, due \(token)") != nil)
    // A longer run is not closed by a shorter one.
    #expect(codeSpans("``a` \(token)").map(\.code) == [false])
    // An escaped backtick opens nothing.
    #expect(codeSpans("\\`not code\\` \(token)").map(\.code) == [false])
  }

  @Test func saysATimeInALinksWordsAsPlainWordsInsideTheLink() throws {
    let soon = Int(Date().timeIntervalSince1970) + 3 * 3600
    let styled = chatInline("[see <t:\(soon):R>](https://example.com) or <t:\(soon):R>")
    #expect(String(styled.characters).hasPrefix("see in 3 hours"))
    let links = styled.runs.compactMap(\.link)
    #expect(links.count == 1 && links.allSatisfy { $0.absoluteString == "https://example.com" })
    let linked = styled.runs.filter { $0.link != nil }.map { String(styled[$0.range].characters) }.joined()
    #expect(linked == "see in 3 hours")
    // The time outside the link is still a chip: the line ends on its words, not the token.
    #expect(String(styled.characters).hasSuffix("in 3 hours\u{2009}"))
  }
}
