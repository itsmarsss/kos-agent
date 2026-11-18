import DeviceCore
import Foundation
import SwiftUI

#if os(macOS)
  import AppKit
#else
  import UIKit
#endif

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
      Text(ask.heading)
        .font(.kos(.body, .semibold))
        .foregroundStyle(Theme.text)
        .fixedSize(horizontal: false, vertical: true)
      if let place = ask.place {
        HStack(spacing: 6) {
          PlaceMark(tool: ask.tool, site: ask.site)
          Text(place).font(.kos(.detail)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
        }
      }
      if let why = ask.why {
        Text("\u{201C}\(why)\u{201D}").font(.kos(.detail)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
      }
      AskStepList(ask.stepLines)
      if let risk = ask.risk ?? ask.reason.flatMap(AskWords.risk) { RiskTag(risk) }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
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
            Text(verbatim: "\(i + 1).").font(.kos(.dense)).monospacedDigit().foregroundStyle(Theme.faint).frame(minWidth: 16, alignment: .trailing)
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
    Text(AskWords.attributed(line)).font(.kos(.dense)).foregroundStyle(Theme.text).fixedSize(horizontal: false, vertical: true)
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

/// The site's own icon, or the kind of place's symbol.
struct PlaceMark: View {
  let tool: String
  let site: String?

  var body: some View {
    if let site, let url = URL(string: "https://\(site)/favicon.ico") {
      AsyncImage(url: url) { phase in
        if let image = phase.image {
          image.resizable().interpolation(.high)
        } else {
          symbol
        }
      }
      .frame(width: 14, height: 14)
      .clipShape(RoundedRectangle(cornerRadius: 3, style: .continuous))
    } else {
      symbol
    }
  }

  private var symbol: some View {
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
    let json = ArgNode.pretty(args)
    #if os(macOS)
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(json, forType: .string)
    #else
      UIPasteboard.general.string = json
    #endif
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
    guard let data = args.data(using: .utf8), let value = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else {
      return .text(args)
    }
    return node(value, source: args)
  }

  /// The arguments laid out for copying: JSON indented, or the text as it came.
  public static func pretty(_ args: String) -> String {
    guard let data = args.data(using: .utf8), let value = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]),
      let out = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .withoutEscapingSlashes, .fragmentsAllowed])
    else { return args }
    return String(decoding: out, as: UTF8.self)
  }

  /// A parsed value as a node. An object's keys keep the order they were written in, which JSONSerialization
  /// drops: each is placed where its name first appears in the text.
  private static func node(_ value: Any, source: String) -> ArgNode {
    switch value {
    case let s as String: return .text(s)
    case let n as NSNumber:
      if CFGetTypeID(n) == CFBooleanGetTypeID() { return .plain(n.boolValue ? "true" : "false") }
      return .plain(n.stringValue)
    case let items as [Any]: return .list(items.map { node($0, source: source) })
    case let object as [String: Any]:
      let at = { (key: String) -> Int in
        source.range(of: "\"\(key)\"").map { source.distance(from: source.startIndex, to: $0.lowerBound) } ?? Int.max
      }
      return .fields(object.keys.sorted { (at($0), $0) < (at($1), $1) }.map { Field(key: $0, value: node(object[$0]!, source: source)) })
    default: return .plain("null")
    }
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

  /// The symbol for where an ask acts, when the site has no icon or there is no site.
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
