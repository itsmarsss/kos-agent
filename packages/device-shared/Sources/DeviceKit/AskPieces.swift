import DeviceCore
import Foundation
import SwiftUI

/// An approval as KOS for Mac and KOS for iPhone ask it, the web kit's AskCard in SwiftUI: what KOS wants to do,
/// where, each action with its keys as keycaps, why it asks, and the arguments folded under Details. The buttons
/// are the surface's own (a row on the Mac, a thumb's stack on the phone), drawn with KOSButtonStyle at one height.
public struct AskSummary: View {
  private let ask: ChatModel.Ask

  public init(_ ask: ChatModel.Ask) {
    self.ask = ask
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      // With steps, they are what is approved: the title says only what they act on, quieter.
      let steps = ask.stepLines
      Text(ask.heading)
        .font(steps.isEmpty ? .kos(.body, .semibold) : .kos(.detail, .semibold))
        .foregroundStyle(steps.isEmpty ? Theme.text : Theme.muted)
        .fixedSize(horizontal: false, vertical: true)
      if let place = ask.place {
        HStack(spacing: 6) {
          PlaceMark(tool: ask.tool)
          Text(place).font(.kos(.detail)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
        }
      }
      if let said = ask.said {
        (Text("KOS says: ").foregroundStyle(Theme.faint) + Text("\u{201C}\(said)\u{201D}").foregroundStyle(Theme.muted))
          .font(.kos(.detail))
          .fixedSize(horizontal: false, vertical: true)
      }
      if let why = ask.why {
        Text("\u{201C}\(why)\u{201D}").font(.kos(.detail)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
      }
      if let secret = ask.secret { AskSecretBlock(secret) }
      AskStepList(steps)
      if let risk = ask.risk ?? ask.reason.flatMap(AskWords.risk) { RiskTag(risk) }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// The secret an ask places, as the web kit's AskSecretBlock shows it: its label and handle, its fields, and where it
/// goes (the app on a Mac, or the page's site), with what the owner should weigh. Never a value.
public struct AskSecretBlock: View {
  private let secret: ChatSecret

  public init(_ secret: ChatSecret) {
    self.secret = secret
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 6) {
        Image(systemName: "key.fill").font(.kos(.detail)).foregroundStyle(Theme.warn).accessibilityHidden(true)
        // A one-time code has no handle until it is given: its label alone.
        (Text(secret.label).font(.kos(.body, .semibold)).foregroundStyle(Theme.text)
          + Text(secret.asksCode ? "" : "  \(secret.handle)").font(.kos(.detail, design: .monospaced)).foregroundStyle(Theme.faint))
          .fixedSize(horizontal: false, vertical: true)
      }
      if let fields = AskWords.secretFields(secret) {
        Text(fields).font(.kos(.detail)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
      }
      if let place = AskWords.secretPlace(secret) {
        Text(place).font(.kos(.body, .semibold)).foregroundStyle(Theme.text).fixedSize(horizontal: false, vertical: true)
      }
      ForEach(secret.warnings ?? [], id: \.self) { warning in
        Text(warning).font(.kos(.detail)).foregroundStyle(Theme.warn).fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 8).fill(Theme.warn.opacity(0.08)))
    .accessibilityElement(children: .combine)
  }
}

/// The masked box an ask for a one-time code has, as the web kit's AskCard draws it: the code is typed here, sent with
/// the yes and emptied, never saved or logged. Return in it approves, once what is typed is a code a card takes.
public struct AskCodeField: View {
  private let secret: ChatSecret
  @Binding private var code: String
  private let submit: () -> Void

  public init(secret: ChatSecret, code: Binding<String>, submit: @escaping () -> Void) {
    self.secret = secret
    _code = code
    self.submit = submit
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      KOSField("The code", placeholder: "Type or paste it", text: $code, mono: true, secure: true)
        // Told it is a one-time code, so the system offers the one a text just brought, and keeps it from the keychain.
        .textContentType(.oneTimeCode)
        .onSubmit { if OneTimeCode.typed(code) != nil { submit() } }
      Text(AskWords.codeHelp(secret)).font(.kos(.detail)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
    }
  }
}

/// Each action of an ask, a line each, numbered when there are several.
public struct AskStepList: View {
  private let lines: [StepLine]

  public init(_ lines: [StepLine]) {
    self.lines = lines
  }

  public var body: some View {
    if lines.count == 1 {
      StepWords(lines[0])
    } else if !lines.isEmpty {
      VStack(alignment: .leading, spacing: 3) {
        ForEach(Array(lines.enumerated()), id: \.offset) { i, line in
          HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(verbatim: "\(i + 1).").font(.kos(.body)).monospacedDigit().foregroundStyle(Theme.faint).frame(minWidth: 16, alignment: .trailing)
            StepWords(line)
          }
        }
      }
    }
  }
}

/// A step's line in one Text, so it wraps as words do; each key on a keycap's tint, in the monospaced face.
public struct StepWords: View {
  private let line: StepLine

  public init(_ line: StepLine) {
    self.line = line
  }

  public var body: some View {
    Text(AskWords.attributed(line)).font(.kos(.body, .medium)).foregroundStyle(Theme.text).fixedSize(horizontal: false, vertical: true)
  }
}

/// Why an ask asks, on the warning's tint.
public struct RiskTag: View {
  private let text: String

  public init(_ text: String) {
    self.text = text
  }

  public var body: some View {
    Text(text)
      .font(.kos(.small, .medium))
      .foregroundStyle(Theme.warn)
      .padding(.horizontal, 8)
      .padding(.vertical, 3)
      .background(Theme.warn.opacity(0.12), in: Capsule())
      .overlay(CapsuleEdge().strokeBorder(Theme.warn.opacity(0.35)))
  }
}

/// The kind of place's own symbol. Never a site's icon: fetching one would reach whatever site the agent named,
/// from the owner's device, before they said yes.
struct PlaceMark: View {
  let tool: String

  var body: some View {
    Image(systemName: AskWords.placeSymbol(tool))
      .font(.system(size: 11))
      .foregroundStyle(Theme.faint)
      .frame(width: 14, height: 14)
  }
}

/// The arguments, folded until asked for: the tool's name, each field by its name, a list numbered, a long string
/// cut with Show all, in a box that scrolls rather than running off the card; and Copy JSON.
public struct AskDetails: View {
  private let tool: String
  private let args: String
  @State private var open = false
  @State private var copied = false
  @State private var tall: CGFloat = 0
  @Environment(\.accessibilityReduceMotion) private var still

  private struct Tall: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
  }

  /// `open` to draw it unfolded, as a picture of it does.
  public init(tool: String, args: String, open: Bool = false) {
    self.tool = tool
    self.args = args
    _open = State(initialValue: open)
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Button {
        withAnimation(still ? nil : Theme.spring) { open.toggle() }
      } label: {
        HStack(spacing: 4) {
          Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).rotationEffect(.degrees(open ? 90 : 0))
          Text("Details").font(.kos(.detail))
        }
        .foregroundStyle(Theme.muted)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(open ? "Hide the details" : "Show the details")
      if open {
        VStack(alignment: .leading, spacing: 8) {
          HStack {
            Text(tool).font(.kos(.small, design: .monospaced)).foregroundStyle(Theme.text)
              .padding(.horizontal, 7).padding(.vertical, 3)
              .background(Theme.panel2, in: Capsule())
              .overlay(CapsuleEdge().strokeBorder(Theme.line))
            Spacer(minLength: 6)
            Button(copied ? "Copied" : "Copy JSON") { copy() }.buttonStyle(KOSButtonStyle(.ghost, small: true))
          }
          // As tall as the fields, up to a scroll's worth: it never runs off the card.
          ScrollView {
            ArgView(node: ArgNode.parse(args))
              .frame(maxWidth: .infinity, alignment: .leading)
              .background(GeometryReader { box in Color.clear.preference(key: Tall.self, value: box.size.height) })
          }
          .frame(height: min(tall, 220))
          .onPreferenceChange(Tall.self) { tall = $0 }
        }
        .padding(10)
        .background(Theme.bg, in: RoundedRectangle(cornerRadius: Theme.radiusSm, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Theme.radiusSm, style: .continuous).strokeBorder(Theme.line))
        .transition(.opacity)
      }
    }
  }

  private func copy() {
    // What KOS is about to send, and a clipboard read's preview of the owner's own: marked, and gone in a minute.
    Clipboard.copy(ArgNode.pretty(args), sensitive: true)
    copied = true
  }
}

/// One value of the arguments, as its kind reads.
struct ArgView: View {
  let node: ArgNode

  var body: some View {
    switch node {
    case .text(let text):
      LongText(text: text)
    case .plain(let text):
      Text(text).font(.kos(.small, design: .monospaced)).foregroundStyle(Theme.text)
    case .list(let items):
      VStack(alignment: .leading, spacing: 2) {
        ForEach(Array(items.enumerated()), id: \.offset) { i, item in
          HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(verbatim: "\(i + 1).").font(.kos(.tiny)).monospacedDigit().foregroundStyle(Theme.faint)
            ArgView(node: item)
          }
        }
      }
    case .fields(let fields):
      VStack(alignment: .leading, spacing: 4) {
        ForEach(Array(fields.enumerated()), id: \.offset) { _, field in
          HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(field.key).font(.kos(.tiny, design: .monospaced)).foregroundStyle(Theme.faint)
            ArgView(node: field.value)
          }
        }
      }
    }
  }
}

/// A string in full when short, cut with Show all when long.
private struct LongText: View {
  let text: String
  @State private var all = false

  var body: some View {
    let long = text.count > ArgNode.long
    VStack(alignment: .leading, spacing: 2) {
      Text(long && !all ? "\(text.prefix(ArgNode.long))…" : text)
        .font(.kos(.small)).foregroundStyle(Theme.text)
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
      if long {
        Button(all ? "Show less" : "Show all") { all.toggle() }.buttonStyle(.plain).font(.kos(.small)).foregroundStyle(Theme.accent)
      }
    }
  }
}

/// The arguments as a tree to lay out: fields by name in the order written, lists numbered, strings, and the rest
/// as written. Text that is not JSON (cut by the host to fit) stays the text it is.
public indirect enum ArgNode: Equatable, Sendable {
  case text(String)
  case plain(String)
  case list([ArgNode])
  case fields([Field])

  public struct Field: Equatable, Sendable {
    public let key: String
    public let value: ArgNode
  }

  /// Strings longer than this are cut, with Show all.
  public static let long = 240

  public static func parse(_ args: String) -> ArgNode {
    var reader = OrderedJSON(Array(args.utf8))
    guard let node = reader.document() else { return .text(args) }
    return node
  }

  /// The arguments laid out for copying: JSON indented, or the text as it came.
  public static func pretty(_ args: String) -> String {
    guard let data = args.data(using: .utf8), let value = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]),
      let out = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .withoutEscapingSlashes, .fragmentsAllowed])
    else { return args }
    return String(decoding: out, as: UTF8.self)
  }
}

/// JSON read into an ArgNode with each object's fields in the order the text gives them, which Foundation's
/// readers do not keep. Nothing for text that is not one whole JSON value.
private struct OrderedJSON {
  private let bytes: [UInt8]
  private var at = 0

  init(_ bytes: [UInt8]) {
    self.bytes = bytes
  }

  mutating func document() -> ArgNode? {
    guard let value = value() else { return nil }
    space()
    return at == bytes.count ? value : nil
  }

  private mutating func space() {
    while at < bytes.count, [0x20, 0x0A, 0x0D, 0x09].contains(bytes[at]) { at += 1 }
  }

  private mutating func value() -> ArgNode? {
    space()
    guard at < bytes.count else { return nil }
    switch bytes[at] {
    case UInt8(ascii: "{"): return object()
    case UInt8(ascii: "["): return list()
    case UInt8(ascii: "\""): return string().map(ArgNode.text)
    default: return literal()
    }
  }

  private mutating func object() -> ArgNode? {
    at += 1
    var fields: [ArgNode.Field] = []
    space()
    if at < bytes.count, bytes[at] == UInt8(ascii: "}") {
      at += 1
      return .fields(fields)
    }
    while true {
      space()
      guard at < bytes.count, bytes[at] == UInt8(ascii: "\""), let key = string() else { return nil }
      space()
      guard at < bytes.count, bytes[at] == UInt8(ascii: ":") else { return nil }
      at += 1
      guard let v = value() else { return nil }
      fields.append(.init(key: key, value: v))
      space()
      guard at < bytes.count else { return nil }
      if bytes[at] == UInt8(ascii: ",") {
        at += 1
      } else if bytes[at] == UInt8(ascii: "}") {
        at += 1
        return .fields(fields)
      } else {
        return nil
      }
    }
  }

  private mutating func list() -> ArgNode? {
    at += 1
    var items: [ArgNode] = []
    space()
    if at < bytes.count, bytes[at] == UInt8(ascii: "]") {
      at += 1
      return .list(items)
    }
    while true {
      guard let v = value() else { return nil }
      items.append(v)
      space()
      guard at < bytes.count else { return nil }
      if bytes[at] == UInt8(ascii: ",") {
        at += 1
      } else if bytes[at] == UInt8(ascii: "]") {
        at += 1
        return .list(items)
      } else {
        return nil
      }
    }
  }

  /// A string's text, its escapes read by Foundation, which knows them all.
  private mutating func string() -> String? {
    let start = at
    at += 1
    while at < bytes.count {
      if bytes[at] == UInt8(ascii: "\\") {
        at += 2
        continue
      }
      if bytes[at] == UInt8(ascii: "\"") {
        at += 1
        return try? JSONDecoder().decode(String.self, from: Data(bytes[start..<at]))
      }
      at += 1
    }
    return nil
  }

  /// A number, true, false or null, as written.
  private mutating func literal() -> ArgNode? {
    let start = at
    while at < bytes.count, !(Set(",]} \n\r\t".utf8)).contains(bytes[at]) { at += 1 }
    let word = String(decoding: bytes[start..<at], as: UTF8.self)
    if word == "true" || word == "false" || word == "null" || Double(word) != nil { return .plain(word) }
    return nil
  }
}

/// The words and symbols an ask's card is drawn with, apart from the views so they can be tested.
public enum AskWords {
  /// A line as one string with its keys set in the monospaced face on a keycap's tint, a thin space either side.
  public static func attributed(_ line: StepLine) -> AttributedString {
    var out = AttributedString()
    for piece in line {
      switch piece {
      case .text(let text):
        out += AttributedString(text)
      case .key(let key):
        var cap = AttributedString("\u{2009}\(key)\u{2009}")
        cap.font = .kos(.detail, .medium, design: .monospaced)
        cap.backgroundColor = Theme.lineStrong.opacity(0.45)
        out += cap
      }
    }
    return out
  }

  /// A line as plain words, its keys as their caps.
  public static func plain(_ line: StepLine) -> String {
    line.map(\.words).joined()
  }

  /// The symbol for where an ask acts.
  /// A secret's fields in words, as the dashboard says them: "password", "card number and CVC".
  public static func secretFields(_ secret: ChatSecret) -> String? {
    let words = secret.fields.map { secretFieldWords[$0] ?? $0 }
    guard let last = words.last else { return nil }
    return words.count == 1 ? last : "\(words.dropLast().joined(separator: ", ")) and \(last)"
  }

  /// Where a secret goes, in words: "Into Safari on Studio MacBook", or the page's site.
  public static func secretPlace(_ secret: ChatSecret) -> String? {
    if let app = secret.app {
      let site = secret.origin.map { " on \($0.replacingOccurrences(of: "https://", with: ""))" } ?? ""
      return "Into \(app.name)\(site)\(secret.device.map { ", on \($0)" } ?? "")"
    }
    return secret.origin.map { "On \($0.replacingOccurrences(of: "https://", with: ""))" }
  }

  /// What a one-time code's box says it is for: where it goes, once, and for how long; never kept.
  public static func codeHelp(_ secret: ChatSecret) -> String {
    let site = secret.origin.map { " on \($0.replacingOccurrences(of: "https://", with: "").replacingOccurrences(of: "http://", with: ""))" }
    let place = site ?? secret.app.map { " into \($0.name)" } ?? ""
    return "\(secret.app == nil ? "Filled" : "Typed") once\(place) within \(OneTimeCode.minutes) minutes, and never saved. Or deny, and type it there yourself."
  }

  static let secretFieldWords = ["number": "card number", "cvc": "CVC", "name": "name on card", "text": "note", "token": "token"]

  public static func placeSymbol(_ tool: String) -> String {
    if tool.hasPrefix("computer.") { return "desktopcomputer" }
    if tool.hasPrefix("files.") || tool == "shell.run" || tool == "python.run" { return "folder" }
    if tool.hasPrefix("mcp."), tool.hasSuffix(".send_email") || tool.hasSuffix(".email_send") { return "envelope" }
    if tool.hasPrefix("mcp.") { return "server.rack" }
    return "globe"
  }

  /// An older host's reason as the card's risk: less what a place says, nothing for "risky tool".
  public static func risk(_ reason: String) -> String? {
    var said = reason
    if let range = said.range(of: ", in your Chrome", options: [.backwards, .anchored]) { said.removeSubrange(range) }
    if said == "risky tool" || (said.hasPrefix("on ") && !said.dropFirst(3).contains(" ")) || said.isEmpty { return nil }
    return said.prefix(1).uppercased() + said.dropFirst()
  }
}
