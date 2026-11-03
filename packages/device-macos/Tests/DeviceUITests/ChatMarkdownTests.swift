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
}
