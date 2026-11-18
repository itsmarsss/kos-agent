import Foundation

/// A typed block in KOS's words: a fenced block whose info string is `kos:<kind>`, `key: value` header lines, a
/// line `---`, then the body as written (docs/blocks.md is the contract). Read as the dashboard reads it
/// (`@kos/shared` blocks.ts); a block whose header is not all `key: value` lines is no block, and is drawn as the
/// code it would otherwise be.
public struct KOSBlock: Equatable, Sendable {
  public struct Field: Equatable, Sendable {
    public let key: String
    public let value: String

    public init(_ key: String, _ value: String) {
      self.key = key
      self.value = value
    }
  }

  public let kind: String
  /// The header, in order; a key that repeats is a list.
  public let fields: [Field]
  public let body: String

  public init(kind: String, fields: [Field], body: String) {
    self.kind = kind
    self.fields = fields
    self.body = body
  }

  /// A fence: how many backticks opened it, its info string, the lines inside, and the line after it.
  public struct Fence: Equatable, Sendable {
    public let ticks: Int
    /// Everything after the backticks, trimmed: `ts title="x"`.
    public let info: String
    /// Its first word: the language, or `kos:<kind>`.
    public var lang: String { info.split(whereSeparator: \.isWhitespace).first.map(String.init) ?? "" }
    public let body: [String]
    public let next: Int
    /// False when the text ended first: a reply still arriving.
    public let closed: Bool
  }

  /// The fence opening at `lines[at]`, read to a line of at least as many backticks and nothing else, so a block
  /// opened with four holds a three-backtick fence in its body; nil when the line opens none. Its info string is
  /// anything without a backtick, as CommonMark has it: ```ts title="x" and ```js {1,3} are fences.
  public static func fence(_ lines: [String], at start: Int) -> Fence? {
    guard start < lines.count else { return nil }
    let line = lines[start].trimmingCharacters(in: .whitespaces)
    let ticks = line.prefix { $0 == "`" }.count
    let info = line.dropFirst(ticks).trimmingCharacters(in: .whitespaces)
    guard ticks >= 3, !info.contains("`") else { return nil }
    // A fence indented under a list item: its lines lose as many spaces as its opener has, as CommonMark has it.
    let indent = lines[start].prefix { $0 == " " }.count
    var body: [String] = []
    var i = start + 1
    while i < lines.count, !closes(lines[i], ticks: ticks) {
      body.append(String(lines[i].dropFirst(min(indent, lines[i].prefix { $0 == " " }.count))))
      i += 1
    }
    let closed = i < lines.count
    return Fence(ticks: ticks, info: info, body: body, next: closed ? i + 1 : i, closed: closed)
  }

  private static func closes(_ line: String, ticks: Int) -> Bool {
    let t = line.trimmingCharacters(in: .whitespaces)
    return t.count >= ticks && t.allSatisfy { $0 == "`" }
  }

  /// The kind an info string's first word names, `kos:email` as "email"; nil for any other fence.
  public static func kind(ofInfo info: String) -> String? {
    let t = info.split(whereSeparator: \.isWhitespace).first.map(String.init) ?? ""
    guard t.lowercased().hasPrefix("kos:") else { return nil }
    let kind = String(t.dropFirst(4)).lowercased()
    guard let first = kind.first, first.isASCII, first.isLetter,
          kind.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }) else { return nil }
    return kind
  }

  /// A fence's lines as a typed block, or nil when its info is not `kos:<kind>` or its header is malformed.
  public static func parse(info: String, lines: [String]) -> KOSBlock? {
    guard let kind = kind(ofInfo: info) else { return nil }
    let rule = lines.firstIndex { $0.trimmingCharacters(in: .whitespaces) == "---" }
    var fields: [Field] = []
    for line in lines[..<(rule ?? lines.count)] where !line.trimmingCharacters(in: .whitespaces).isEmpty {
      guard let field = headerField(line.trimmingCharacters(in: .whitespaces)) else { return nil }
      fields.append(field)
    }
    let body = rule.map { Array(lines[($0 + 1)...]) } ?? []
    return KOSBlock(kind: kind, fields: fields, body: trimBlankEnds(body).joined(separator: "\n"))
  }

  /// `key: value`: a key a letter then letters, digits, `-` and `_`, case folded; the value trimmed.
  private static func headerField(_ line: String) -> Field? {
    guard let colon = line.firstIndex(of: ":") else { return nil }
    let key = line[..<colon]
    guard let first = key.first, first.isASCII, first.isLetter,
          key.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else { return nil }
    return Field(key.lowercased(), line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces))
  }

  private static func trimBlankEnds(_ lines: [String]) -> [String] {
    let blank = { (l: String) in l.trimmingCharacters(in: .whitespaces).isEmpty }
    guard let start = lines.firstIndex(where: { !blank($0) }), let end = lines.lastIndex(where: { !blank($0) }) else { return [] }
    return Array(lines[start...end])
  }

  /// Every value a key has, in order; none when it is absent or empty.
  public func values(_ key: String) -> [String] {
    fields.filter { $0.key == key && !$0.value.isEmpty }.map(\.value)
  }

  public func value(_ key: String) -> String? {
    values(key).first
  }
}

/// How a block's body is drawn: as written, as markdown, monospace, or by its lines.
public enum BlockBody: String, Sendable {
  case text, markdown, mono, checklist, steps, quote, diff
}

/// What a block offers. Each is local, or (Send) a request to KOS whose tool call is approved as any other.
public enum BlockAction: String, Sendable {
  case copy, mail, send, ics, map
}

/// What Copy copies: the body, or the whole block in words.
public enum BlockCopies: String, Sendable {
  case body, all
}

/// A kind of typed block, as `BLOCK_KINDS` in `@kos/shared` blockkinds.ts has it; blockkinds.test.ts reads this
/// file and fails when the two tables drift.
public struct BlockKind: Equatable, Sendable {
  public struct FieldSpec: Equatable, Sendable {
    public let key: String
    public let label: String
    public let list: Bool

    public init(_ key: String, _ label: String, list: Bool = false) {
      self.key = key
      self.label = label
      self.list = list
    }
  }

  public let name: String
  /// The small head over the block; empty for a card, whose title heads it.
  public let label: String
  /// The first line of its plain words: "Draft email".
  public let plain: String
  public let fields: [FieldSpec]
  /// The field drawn as the title rather than as a row.
  public let title: String?
  public let body: BlockBody
  public let copies: BlockCopies
  public let actions: [BlockAction]

  public static let all: [BlockKind] = [
    BlockKind(name: "email", label: "Email", plain: "Draft email", fields: [.init("to", "To", list: true), .init("cc", "Cc", list: true), .init("bcc", "Bcc", list: true), .init("subject", "Subject")], title: nil, body: .text, copies: .body, actions: [.copy, .mail, .send]),
    BlockKind(name: "message", label: "Message", plain: "Draft message", fields: [.init("to", "To", list: true), .init("channel", "Via")], title: nil, body: .text, copies: .body, actions: [.copy, .send]),
    BlockKind(name: "event", label: "Event", plain: "Event", fields: [.init("when", "When"), .init("end", "Ends"), .init("where", "Where"), .init("notes", "Notes")], title: "title", body: .text, copies: .all, actions: [.copy, .ics]),
    BlockKind(name: "contact", label: "Contact", plain: "Contact", fields: [.init("phone", "Phone", list: true), .init("email", "Email", list: true), .init("company", "Company"), .init("address", "Address"), .init("notes", "Notes")], title: "name", body: .text, copies: .all, actions: [.copy]),
    BlockKind(name: "address", label: "Address", plain: "Address", fields: [.init("phone", "Phone"), .init("notes", "Notes")], title: "name", body: .text, copies: .body, actions: [.copy, .map]),
    BlockKind(name: "checklist", label: "Checklist", plain: "Checklist", fields: [], title: "title", body: .checklist, copies: .body, actions: [.copy]),
    BlockKind(name: "steps", label: "Steps", plain: "Steps", fields: [], title: "title", body: .steps, copies: .body, actions: [.copy]),
    BlockKind(name: "quote", label: "Quote", plain: "Quote", fields: [.init("source", "Source")], title: nil, body: .quote, copies: .body, actions: [.copy]),
    BlockKind(name: "command", label: "Command", plain: "Command", fields: [.init("cwd", "In")], title: nil, body: .mono, copies: .body, actions: [.copy]),
    BlockKind(name: "diff", label: "Diff", plain: "Diff", fields: [], title: "file", body: .diff, copies: .body, actions: [.copy]),
    BlockKind(name: "card", label: "", plain: "", fields: [], title: "title", body: .markdown, copies: .all, actions: [.copy]),
  ]

  /// A channel's own name, for a `channel:` field written as its key, as CHANNEL_NAMES in blockkinds.ts.
  public static let channelNames = ["imessage": "iMessage", "sms": "SMS", "discord": "Discord"]

  /// A kind by name; one not in the table is a card under its own name, so nothing is drawn as a broken block.
  public static func named(_ name: String) -> BlockKind {
    if let known = all.first(where: { $0.name == name }) { return known }
    let label = words(name)
    return BlockKind(name: name, label: label, plain: label, fields: [], title: "title", body: .markdown, copies: .all, actions: [.copy])
  }

  /// A key as a label: "follow-up" as "Follow up".
  static func words(_ key: String) -> String {
    let spaced = key.replacingOccurrences(of: #"[-_]+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
    return spaced.prefix(1).uppercased() + spaced.dropFirst()
  }
}

/// A block laid out: its kind, its title, its fields as rows, its body, and the links its `action:` fields ask for.
public struct BlockLayout: Equatable, Sendable {
  public struct Row: Equatable, Sendable {
    public let key: String
    public let label: String
    public let values: [String]
  }

  public struct Link: Equatable, Sendable {
    public let label: String
    public let url: URL
    /// The host as it is reached, punycode and all, shown beside KOS's words so they cannot pass for another.
    public let host: String
  }

  public let kind: BlockKind
  public let title: String?
  public let rows: [Row]
  public let body: String
  public let links: [Link]
}

extension KOSBlock {
  /// The header as rows: the kind's own fields in its order, then any other in the order written.
  public var layout: BlockLayout {
    let kind = BlockKind.named(self.kind)
    var keys = kind.fields.map(\.key)
    for field in fields where !keys.contains(field.key) { keys.append(field.key) }
    let rows = keys.compactMap { key -> BlockLayout.Row? in
      guard key != kind.title, key != "action" else { return nil }
      let found = values(key)
      guard !found.isEmpty else { return nil }
      let shown = key == "channel" ? found.map { BlockKind.channelNames[$0.lowercased()] ?? $0 } : found
      return .init(key: key, label: kind.fields.first { $0.key == key }?.label ?? BlockKind.words(key), values: shown)
    }
    let links = values("action").compactMap(Self.link)
    return BlockLayout(kind: kind, title: kind.title.flatMap(value), rows: rows, body: body, links: links)
  }

  /// `open <url> [words]` as a link, only to an https address with no user in it; anything else is no link.
  static func link(_ action: String) -> BlockLayout.Link? {
    let parts = action.split(maxSplits: 2, omittingEmptySubsequences: true, whereSeparator: \.isWhitespace).map(String.init)
    guard parts.count >= 2, parts[0].lowercased() == "open", let parsed = URLComponents(string: parts[1]),
          parsed.scheme?.lowercased() == "https", parsed.user == nil, parsed.password == nil,
          let url = parsed.url, let host = url.host, !host.isEmpty else { return nil }
    let words = (parts.count > 2 ? parts[2] : "").unicodeScalars.filter { !bidiMarks.contains($0) }
    let label = String(String.UnicodeScalarView(words)).trimmingCharacters(in: .whitespaces)
    // The host with its port, as it is reached.
    return .init(label: label.isEmpty ? "Open" : label, url: url, host: url.port.map { "\(host):\($0)" } ?? host)
  }

  /// Marks that turn text around without showing: a label carrying one could read as something else.
  private static let bidiMarks = CharacterSet(charactersIn: "\u{061C}\u{200E}\u{200F}")
    .union(CharacterSet(charactersIn: "\u{202A}"..."\u{202E}"))
    .union(CharacterSet(charactersIn: "\u{2066}"..."\u{2069}"))

  /// The block in plain words: its heading, a line per field, then the body after a blank line.
  public var plain: String {
    let layout = layout
    let heading = [layout.kind.plain, layout.title ?? ""].filter { !$0.isEmpty }.joined(separator: ": ")
    let head = (heading.isEmpty ? [] : [heading]) + layout.rows.map { "\($0.label): \($0.values.joined(separator: ", "))" }
      + layout.links.map { "\($0.label): \($0.url.absoluteString)" }
    return [head.joined(separator: "\n"), body].filter { !$0.isEmpty }.joined(separator: "\n\n")
  }

  /// What Copy puts on the clipboard: a draft's body, or the whole block in words.
  public var copyText: String {
    BlockKind.named(kind).copies == .body && !body.isEmpty ? body : plain
  }

  /// A draft email as a `mailto:` link for the owner's own mail app.
  public var mailto: URL? {
    let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
    let encode = { (s: String) in s.addingPercentEncoding(withAllowedCharacters: allowed) ?? "" }
    let query = [
      ("cc", values("cc").joined(separator: ",")),
      ("bcc", values("bcc").joined(separator: ",")),
      ("subject", value("subject") ?? ""),
      ("body", body),
    ].filter { !$0.1.isEmpty }.map { "\($0.0)=\(encode($0.1))" }.joined(separator: "&")
    return URL(string: "mailto:\(values("to").map(encode).joined(separator: ","))\(query.isEmpty ? "" : "?\(query)")")
  }

  /// Where an address is, on a map in the browser.
  public var map: URL? {
    let place = [value("name") ?? "", body.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined(separator: ", ")]
      .filter { !$0.isEmpty }.joined(separator: ", ")
    guard !place.isEmpty, let q = place.addingPercentEncoding(withAllowedCharacters: .alphanumerics) else { return nil }
    return URL(string: "https://www.google.com/maps/search/?api=1&query=\(q)")
  }

  /// A checklist's lines: an item ticked or not (`- [x] words`), or a line of words between them (`done` nil).
  public var checklist: [(text: String, done: Bool?)] {
    let item = try? NSRegularExpression(pattern: #"^[-*+]\s+\[([ xX])\]\s*(.*)$"#)
    return body.components(separatedBy: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.map { line in
      let t = line.trimmingCharacters(in: .whitespaces)
      guard let m = item?.firstMatch(in: t, range: NSRange(t.startIndex..., in: t)),
            let mark = Range(m.range(at: 1), in: t), let words = Range(m.range(at: 2), in: t) else { return (t, nil) }
      return (String(t[words]), t[mark] != " ")
    }
  }

  /// Steps, a line each, the number or bullet they were written with taken off.
  public var steps: [String] {
    body.components(separatedBy: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.map {
      $0.replacingOccurrences(of: #"^\s*(?:\d{1,3}[.)]|[-*+])\s+"#, with: "", options: .regularExpression).trimmingCharacters(in: .whitespaces)
    }
  }
}

/// A diff line's sort: added, removed, a hunk's head, or context.
public enum DiffLine: String, Sendable {
  case add, del, hunk, same

  public init(_ line: String) {
    if line.hasPrefix("@@") { self = .hunk }
    else if line.hasPrefix("+"), !line.hasPrefix("+++") { self = .add }
    else if line.hasPrefix("-"), !line.hasPrefix("---") { self = .del }
    else { self = .same }
  }
}

extension KOSBlock {
  /// What the block is, said aloud: "a draft email to Sam", "an event, Dinner at Nopa", "a checklist".
  public var spoken: String {
    let layout = layout
    let to = values("to").first.map { " to \($0)" } ?? ""
    switch kind {
    case "email": return "a draft email\(to)"
    case "message": return "a draft message\(to)"
    default:
      let what = layout.kind.label.isEmpty ? "a note" : article(layout.kind.label.lowercased())
      return layout.title.map { "\(what), \($0)" } ?? what
    }
  }

  private func article(_ word: String) -> String {
    ("aeiou".contains(word.first ?? "x") ? "an " : "a ") + word
  }
}
