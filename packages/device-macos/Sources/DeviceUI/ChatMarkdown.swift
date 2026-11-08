import SwiftUI

/// KOS's words in the window: the markdown a chat uses, as the side panel
/// reads it (packages/browser-extension ui/markdown.tsx). Paragraphs,
/// headings, lists that nest, quotes, fenced code, tables, the small "-#"
/// line; inline, bold, italics, code and links, and KOS's references
/// (@page:[Budget]) as the names they stand for, on the panel's violet chip. LaTeX is shown as written.
/// Nothing in it is markup: it is drawn, never run.
public enum ChatBlock: Equatable {
  case paragraph(String)
  case heading(Int, String)
  case small(String)
  case quote(String)
  case code(String)
  case list(ordered: Bool, start: Int, items: [[ChatBlock]])
  case table(head: [String], align: [HorizontalAlignment], rows: [[String]])

  public static func == (a: ChatBlock, b: ChatBlock) -> Bool {
    switch (a, b) {
    case (.paragraph(let x), .paragraph(let y)), (.small(let x), .small(let y)), (.quote(let x), .quote(let y)), (.code(let x), .code(let y)):
      return x == y
    case (.heading(let l, let x), .heading(let m, let y)):
      return l == m && x == y
    case (.list(let o, let s, let i), .list(let p, let t, let j)):
      return o == p && s == t && i == j
    case (.table(let h, let a, let r), .table(let k, let b, let s)):
      return h == k && a.map(Self.word) == b.map(Self.word) && r == s
    default:
      return false
    }
  }

  private static func word(_ a: HorizontalAlignment) -> String {
    a == .center ? "center" : a == .trailing ? "trailing" : "leading"
  }

  /// The blocks of a text, read line by line.
  public static func blocks(_ text: String) -> [ChatBlock] {
    let lines = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
    var out: [ChatBlock] = []
    var para: [String] = []
    func flush() {
      if !para.isEmpty { out.append(.paragraph(para.joined(separator: "\n"))) }
      para = []
    }
    var i = 0
    while i < lines.count {
      let line = lines[i]
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      if trimmed.hasPrefix("```") || trimmed == "$$" {
        flush()
        let fence = trimmed.hasPrefix("```") ? "```" : "$$"
        var code: [String] = []
        i += 1
        while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix(fence) {
          code.append(lines[i])
          i += 1
        }
        out.append(.code(dedent(code).joined(separator: "\n")))
        i += 1
        continue
      }
      if isRow(line) {
        flush()
        var rows: [String] = []
        while i < lines.count, isRow(lines[i]) {
          rows.append(lines[i])
          i += 1
        }
        if rows.count > 1, let align = alignment(rows[1]) {
          out.append(.table(head: cells(rows[0]), align: align, rows: rows.dropFirst(2).map(cells)))
        } else {
          out.append(.code(rows.map { $0.trimmingCharacters(in: .whitespaces) }.joined(separator: "\n")))
        }
        continue
      }
      if let heading = match(#"^(#{1,4})\s+(.*)$"#, line) {
        flush()
        out.append(.heading(heading[1].count, heading[2]))
        i += 1
        continue
      }
      if let small = match(#"^-#\s+(.*)$"#, line) {
        flush()
        out.append(.small(small[1]))
        i += 1
        continue
      }
      if itemOf(line) != nil {
        flush()
        let (list, next) = readList(lines, from: i)
        out.append(list)
        i = next
        continue
      }
      if let quote = match(#"^>\s?(.*)$"#, line) {
        flush()
        if case .quote(let before) = out.last {
          out[out.count - 1] = .quote(before + "\n" + quote[1])
        } else {
          out.append(.quote(quote[1]))
        }
        i += 1
        continue
      }
      if trimmed.isEmpty {
        flush()
      } else {
        para.append(line)
      }
      i += 1
    }
    flush()
    return out
  }

  /// A list item's start: its indent, whether it is numbered and its number, and where its words begin.
  private static func itemOf(_ line: String) -> (indent: Int, ordered: Bool, number: Int, content: Int)? {
    guard let m = match(#"^(\s*)([-*+]|\d{1,9}[.)])\s+"#, line) else { return nil }
    let marker = m[2]
    let ordered = marker.first?.isNumber == true
    return (m[1].count, ordered, ordered ? Int(marker.dropLast()) ?? 1 : 1, m[0].count)
  }

  /// A run of items at one indent, each item's lines read as blocks of their own.
  private static func readList(_ lines: [String], from start: Int) -> (ChatBlock, Int) {
    guard let first = itemOf(lines[start]) else { return (.paragraph(lines[start]), start + 1) }
    var items: [[String]] = []
    var i = start
    while i < lines.count {
      let line = lines[i]
      if let item = itemOf(line), item.indent == first.indent, item.ordered == first.ordered {
        items.append([String(line.dropFirst(item.content))])
        i += 1
        continue
      }
      let indent = line.prefix { $0 == " " || $0 == "\t" }.count
      let blank = line.trimmingCharacters(in: .whitespaces).isEmpty
      // Under an item: deeper than its marker, or a blank line with more of the item after it.
      if !items.isEmpty, indent > first.indent || (blank && i + 1 < lines.count && (lines[i + 1].prefix { $0 == " " }.count > first.indent)) {
        items[items.count - 1].append(line)
        i += 1
        continue
      }
      break
    }
    let bodies = items.map { blocks(dedent($0, keepFirst: true).joined(separator: "\n")) }
    return (.list(ordered: first.ordered, start: first.number, items: bodies), i)
  }

  /// Lines with the indent they share taken off; the first kept as it is when it began after a marker.
  private static func dedent(_ lines: [String], keepFirst: Bool = false) -> [String] {
    let rest = keepFirst ? Array(lines.dropFirst()) : lines
    let indents = rest.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.map { $0.prefix { $0 == " " }.count }
    let cut = indents.min() ?? 0
    let trimmed = rest.map { $0.count >= cut ? String($0.dropFirst(cut)) : $0.trimmingCharacters(in: .whitespaces) }
    return keepFirst ? [lines.first ?? ""] + trimmed : trimmed
  }

  private static func isRow(_ line: String) -> Bool {
    let t = line.trimmingCharacters(in: .whitespaces)
    return t.count > 1 && t.hasPrefix("|") && t.hasSuffix("|")
  }

  /// A row's cells, its outer pipes dropped; a \| stays in its cell.
  private static func cells(_ row: String) -> [String] {
    var t = row.trimmingCharacters(in: .whitespaces)
    if t.hasPrefix("|") { t.removeFirst() }
    if t.hasSuffix("|") { t.removeLast() }
    var out: [String] = []
    var cell = ""
    var escaped = false
    for ch in t {
      if escaped {
        cell.append(ch == "|" ? "|" : "\\\(ch)")
        escaped = false
      } else if ch == "\\" {
        escaped = true
      } else if ch == "|" {
        out.append(cell.trimmingCharacters(in: .whitespaces))
        cell = ""
      } else {
        cell.append(ch)
      }
    }
    out.append(cell.trimmingCharacters(in: .whitespaces))
    return out
  }

  /// The line under a table's head, |---|:---:|, as each column's alignment, or nothing when it is not one.
  private static func alignment(_ row: String) -> [HorizontalAlignment]? {
    let parts = cells(row)
    guard parts.allSatisfy({ match(#"^:?-+:?$"#, $0) != nil }) else { return nil }
    return parts.map { $0.hasPrefix(":") && $0.hasSuffix(":") ? .center : $0.hasSuffix(":") ? .trailing : .leading }
  }

  private static func match(_ pattern: String, _ text: String) -> [String]? {
    guard let re = try? NSRegularExpression(pattern: pattern),
          let m = re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) else { return nil }
    return (0..<m.numberOfRanges).map { i in
      Range(m.range(at: i), in: text).map { String(text[$0]) } ?? ""
    }
  }
}

/// One line of inline marks, as styled text: bold, italics, code, links (the web and mail only), references by name,
/// times on this Mac's clock.
/// `size` is the text's own, which a code span sits at nine tenths of, as the dashboard draws one.
public func chatInline(_ text: String, size: CGFloat = KOSType.body.rawValue) -> AttributedString {
  var source = text
  // KOS's references, @page:[Budget] or @approval:6, as the names they stand for, marked for the violet chip the panel draws.
  source = source.replacingOccurrences(of: #"@([a-z]+):\[([^\]\n]+)\]"#, with: "[$2](\(referenceScheme):$1)", options: .regularExpression)
  source = source.replacingOccurrences(of: #"@([a-z]+):([\w.:/-]*\w)"#, with: "[$1 $2](\(referenceScheme):$1)", options: .regularExpression)
  // A time, <t:1760845320:R>, as its words on this Mac's clock, marked for the grey chip; never inside a code span.
  source = outsideCode(source) { part in
    var out = part
    for found in ChatTime.tokens(in: part).reversed() {
      out.replaceSubrange(found.range, with: "[\(ChatTime.words(found.date, style: found.style))](\(timeScheme):\(Int(found.date.timeIntervalSince1970)))")
    }
    return out
  }
  // A bare address is a link too, as the panel makes it.
  source = source.replacingOccurrences(of: #"(?<![(<\[])\b(https?://[^\s<>)\]]+[^\s<>)\].,;:!?])"#, with: "<$1>", options: .regularExpression)
  guard let parsed = try? AttributedString(markdown: source, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) else {
    return AttributedString(text)
  }
  var styled = AttributedString()
  for run in parsed.runs {
    var piece = AttributedString(parsed[run.range])
    if run.inlinePresentationIntent?.contains(.code) == true {
      // A code span on panel-2, as the dashboard and the panel draw one, padded at each end as theirs are.
      piece.swiftUI.backgroundColor = Theme.panel2
      piece.swiftUI.font = .system(size: (size * 0.9).rounded(), design: .monospaced)
      styled += pad(Theme.panel2, size: size) + piece + pad(Theme.panel2, size: size)
      continue
    }
    guard let link = run.link else {
      styled += piece
      continue
    }
    piece.link = nil
    if link.scheme == timeScheme {
      // A time: the dashboard's grey chip; its full date is the line's hover (`timesHelp`).
      let tint = Color(white: 0.5).opacity(0.18).blended(over: Theme.bg)
      piece.swiftUI.backgroundColor = tint
      styled += pad(tint, size: size) + piece + pad(tint, size: size)
    } else if link.scheme == referenceScheme {
      // A reference: the panel's violet chip, at the chip's 12, not a link.
      let tint = Theme.violet.opacity(Theme.tint).blended(over: Theme.bg)
      piece.swiftUI.foregroundColor = Theme.violet
      piece.swiftUI.backgroundColor = tint
      piece.swiftUI.font = .kos(.detail, .medium)
      styled += pad(tint, size: size) + piece + pad(tint, size: size)
    } else if ["http", "https", "mailto"].contains(link.scheme?.lowercased() ?? "") {
      // Nothing but the web and mail opens from KOS's words; what does is underlined, as in the dashboard's prose.
      piece.link = link
      piece.swiftUI.foregroundColor = Theme.accent
      piece.swiftUI.underlineStyle = .single
      styled += piece
    } else {
      styled += piece
    }
  }
  return styled
}

/// The scheme a reference is marked with between reading it and drawing it; nothing opens it.
private let referenceScheme = "kos-ref"

/// The scheme a time is marked with between reading it and drawing it; nothing opens it.
private let timeScheme = "kos-time"

/// A line with `change` applied to what is outside its `code spans`.
private func outsideCode(_ text: String, _ change: (String) -> String) -> String {
  text.components(separatedBy: "`").enumerated().map { i, part in i.isMultiple(of: 2) ? change(part) : part }.joined(separator: "`")
}

/// The hover text for a line's times, as the dashboard's card says each; a time inside a code span is no time.
func timesHelpText(_ text: String) -> String? {
  var outside: [String] = []
  _ = outsideCode(text) { part in
    outside.append(part)
    return part
  }
  return ChatTime.help(for: outside.joined(separator: " "))
}

extension View {
  /// The full date and time of each time in a line, on hover, as the dashboard's card shows it.
  @ViewBuilder func timesHelp(_ text: String) -> some View {
    if let help = timesHelpText(text) { self.help(help) } else { self }
  }
}

/// A sliver of the tint a span sits on, for its ends: a Text run cannot be padded, so a thin space stands in for the panel's padding.
private func pad(_ tint: Color, size: CGFloat) -> AttributedString {
  var space = AttributedString("\u{2009}")
  space.swiftUI.backgroundColor = tint
  space.swiftUI.font = .system(size: (size * 0.9).rounded())
  return space
}

/// KOS's words, drawn.
public struct ChatMarkdown: View {
  private let blocks: [ChatBlock]

  public init(_ text: String) {
    blocks = ChatBlock.blocks(text)
  }

  public var body: some View {
    BlocksView(blocks: blocks)
  }
}

private struct BlocksView: View {
  let blocks: [ChatBlock]
  /// How deep in lists these are: a list under a list marks its items as the dashboard does, disc then circle then square.
  var depth = 0

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
        BlockView(block: block, depth: depth)
      }
    }
  }
}

private struct BlockView: View {
  let block: ChatBlock
  let depth: Int

  /// An item's mark: a disc, a circle, a square for bullets, drawn at the size the dashboard's are;
  /// numbers, then letters under numbers.
  @ViewBuilder private func mark(ordered: Bool, n: Int) -> some View {
    if ordered {
      Text(verbatim: depth == 0 ? "\(n)." : "\(Array("abcdefghijklmnopqrstuvwxyz")[(n - 1) % 26]).").monospacedDigit()
    } else {
      // A glyph at a small size, so it sits on the line's baseline as text does.
      Text(["●", "○", "■"][min(depth, 2)]).font(.system(size: depth == 2 ? 6 : 7))
    }
  }

  var body: some View {
    switch block {
    case .paragraph(let text):
      Text(chatInline(text)).fixedSize(horizontal: false, vertical: true).timesHelp(text)
    case .heading(_, let text):
      // One size for every level, the chat's own, set apart by weight, as the dashboard's are.
      Text(chatInline(text)).font(.kos(.body, .semibold)).padding(.top, 2).timesHelp(text)
    case .small(let text):
      Text(chatInline(text, size: KOSType.detail.rawValue)).font(.kos(.detail)).foregroundStyle(Theme.muted).timesHelp(text)
    case .quote(let text):
      Text(chatInline(text))
        .foregroundStyle(Theme.muted)
        .padding(.leading, 10)
        .overlay(alignment: .leading) { Rectangle().fill(Theme.lineStrong).frame(width: 2) }
        .timesHelp(text)
    case .code(let code):
      Card(padding: EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0)) {
        ScrollView(.horizontal, showsIndicators: false) {
          Text(code).font(.kos(.dense, design: .monospaced)).foregroundStyle(Theme.text)
            .padding(.horizontal, 11).padding(.vertical, 10)
        }
      }
    case .list(let ordered, let start, let items):
      VStack(alignment: .leading, spacing: 3) {
        ForEach(Array(items.enumerated()), id: \.offset) { i, item in
          // The mark in a column 19 wide, as the dashboard indents a list.
          HStack(alignment: .firstTextBaseline, spacing: 0) {
            mark(ordered: ordered, n: start + i).frame(width: 19, alignment: .leading)
            BlocksView(blocks: item, depth: depth + 1)
          }
        }
      }
    case .table(let head, let align, let rows):
      ScrollView(.horizontal, showsIndicators: false) {
        // The dashboard's table: a head of 13 in the muted grey, cells of 14, 6 by 11 around each, a line under each row.
        Grid(alignment: .leading, horizontalSpacing: 22, verticalSpacing: 6) {
          GridRow {
            ForEach(Array(head.enumerated()), id: \.offset) { j, cell in
              Text(chatInline(cell, size: KOSType.dense.rawValue)).font(.kos(.dense, .semibold)).foregroundStyle(Theme.muted)
                .gridColumnAlignment(j < align.count ? align[j] : .leading)
            }
          }
          ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
            Hairline()
            GridRow {
              ForEach(0..<head.count, id: \.self) { j in
                Text(chatInline(j < row.count ? row[j] : "", size: KOSType.table.rawValue)).font(.kos(.table))
                  .timesHelp(j < row.count ? row[j] : "")
              }
            }
          }
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 2)
      }
    }
  }
}
