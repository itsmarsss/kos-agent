import DeviceCore
import SwiftUI

#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// A typed block (docs/blocks.md) drawn as the thing it is, as the dashboard's `KosBlockView` draws it: the kind's
/// label and its actions on one line, the title, the fields in two aligned columns, a hairline, then the body.
/// Its actions are local: Copy, Open in Mail and a map open on this device and send nothing.
public struct KOSBlockView: View {
  private let block: KOSBlock
  private let layout: BlockLayout
  @Environment(\.chatOpensArtifacts) private var opens

  public init(block: KOSBlock) {
    self.block = block
    layout = block.layout
  }

  public var body: some View {
    Card(spacing: 8) {
      head
      if !layout.kind.label.isEmpty, let title = layout.title {
        Text(chatInline(title, opens: opens)).font(.kos(.body, .semibold)).fixedSize(horizontal: false, vertical: true)
      }
      if !layout.rows.isEmpty { rows }
      if !layout.body.isEmpty {
        if !layout.rows.isEmpty, [BlockBody.text, .markdown].contains(layout.kind.body) { Hairline().padding(.vertical, 2) }
        BlockBodyView(block: block, style: layout.kind.body)
      }
    }
    // Its own colour, not the line's, whatever the line around it is drawn in (a muted note), as the kit's block.
    .foregroundStyle(Theme.text)
    .font(.kos(.body))
    .accessibilityElement(children: .contain)
    .accessibilityLabel(layout.kind.label.isEmpty ? layout.title ?? "Note" : layout.kind.label)
  }

  /// The kind's small label, or a card's title in its place, with the actions at the right, one height.
  private var head: some View {
    HStack(alignment: .center, spacing: 8) {
      if layout.kind.label.isEmpty {
        Text(chatInline(layout.title ?? "Note", opens: opens)).font(.kos(.body, .semibold)).fixedSize(horizontal: false, vertical: true)
      } else {
        SectionLabel(layout.kind.label)
      }
      Spacer(minLength: 0)
      BlockActions(block: block, layout: layout)
    }
    .frame(minHeight: 26)
  }

  /// The fields in two columns, the labels' as wide as the widest, a long value wrapping under itself.
  private var rows: some View {
    Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 14, verticalSpacing: 5) {
      ForEach(layout.rows, id: \.key) { row in
        GridRow {
          Text(row.label).font(.kos(.body)).foregroundStyle(Theme.muted)
          value(row.values)
            .font(.kos(.body))
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .timesHelp(row.values.joined(separator: ", "))
        }
      }
    }
  }
}

extension KOSBlockView {
  /// A row's values: addresses as written, as the dashboard shows them, never turned into mail links; anything
  /// else in KOS's inline marks (a time, a reference).
  fileprivate func value(_ values: [String]) -> Text {
    let joined = values.joined(separator: ", ")
    let addresses = values.allSatisfy { $0.range(of: #"^[^\s@]+@[^\s@]+$"#, options: .regularExpression) != nil }
    return addresses ? Text(verbatim: joined) : Text(chatInline(joined, opens: opens))
  }
}

/// The actions a block offers here: links it asks for, a map, Open in Mail, and Copy last, each the kit's round button.
private struct BlockActions: View {
  let block: KOSBlock
  let layout: BlockLayout
  @Environment(\.openURL) private var openURL
  @State private var copied = false

  var body: some View {
    HStack(spacing: 2) {
      ForEach(layout.links, id: \.url) { link in
        IconButton(symbol: "arrow.up.right.square", label: link.label) { openURL(link.url) }
      }
      if layout.kind.actions.contains(.map), let map = block.map {
        IconButton(symbol: "mappin.and.ellipse", label: "Open in Maps") { openURL(map) }
      }
      if layout.kind.actions.contains(.mail), let mail = block.mailto {
        IconButton(symbol: "envelope", label: "Open in Mail") { openURL(mail) }
      }
      IconButton(symbol: copied ? "checkmark" : "doc.on.doc", label: copied ? "Copied" : "Copy") {
        copyToClipboard(block.copyText)
        copied = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { copied = false }
      }
    }
    .padding(.trailing, -4)
  }
}

private func copyToClipboard(_ text: String) {
  #if os(macOS)
  NSPasteboard.general.clearContents()
  NSPasteboard.general.setString(text, forType: .string)
  #else
  UIPasteboard.general.string = text
  #endif
}

/// A block's body by its kind: words as written, markdown, monospace, ticks, numbered steps, a quote or a diff.
private struct BlockBodyView: View {
  let block: KOSBlock
  let style: BlockBody

  var body: some View {
    switch style {
    case .text:
      Text(verbatim: block.body).font(.kos(.body)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
    case .markdown:
      ChatMarkdown(block.body)
    case .mono:
      code(Text(verbatim: block.body))
    case .diff:
      code(block.body.components(separatedBy: "\n").reduce(Text("")) { text, line in
        let sort = DiffLine(line)
        let tone = sort == .add ? Theme.ok : sort == .del ? Theme.danger : sort == .hunk ? Theme.muted : Theme.text
        return text + Text(verbatim: line + "\n").foregroundColor(tone)
      })
    case .checklist:
      VStack(alignment: .leading, spacing: 6) {
        ForEach(Array(block.checklist.enumerated()), id: \.offset) { _, item in
          if let done = item.done {
            CheckRow(text: item.text, done: done)
          } else {
            Text(chatInline(item.text)).font(.kos(.body)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
          }
        }
      }
    case .steps:
      VStack(alignment: .leading, spacing: 6) {
        ForEach(Array(block.steps.enumerated()), id: \.offset) { n, step in
          HStack(alignment: .firstTextBaseline, spacing: 9) {
            Text("\(n + 1)").font(.kos(.tiny, .semibold)).monospacedDigit().foregroundStyle(Theme.muted)
              .frame(width: 20, height: 20).background(Theme.panel2, in: Circle())
              .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 5 }
            Text(chatInline(step)).font(.kos(.body)).fixedSize(horizontal: false, vertical: true)
          }
        }
      }
    case .quote:
      Text(verbatim: block.body).font(.kos(.body)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
        .padding(.leading, 10)
        .overlay(alignment: .leading) { Rectangle().fill(Theme.lineStrong).frame(width: 2) }
    }
  }

  /// Monospace on panel-2, wrapped: a command is read and copied whole, a narrow phone included.
  private func code(_ text: Text) -> some View {
    text.font(.kos(.dense, design: .monospaced)).foregroundStyle(Theme.text).textSelection(.enabled)
      .fixedSize(horizontal: false, vertical: true)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 11).padding(.vertical, 9)
      .background(Theme.panel2, in: RoundedRectangle(cornerRadius: Theme.radiusSm, style: .continuous))
  }
}

/// A checklist item that ticks here only: the reply is not changed by it.
private struct CheckRow: View {
  let text: String
  @State var done: Bool

  var body: some View {
    Button { done.toggle() } label: {
      HStack(alignment: .firstTextBaseline, spacing: 9) {
        Image(systemName: done ? "checkmark.square.fill" : "square")
          .font(.kos(.body)).foregroundStyle(done ? Theme.accent : Theme.muted)
        Text(chatInline(text)).font(.kos(.body)).foregroundStyle(done ? Theme.muted : Theme.text)
          .strikethrough(done, color: Theme.muted).fixedSize(horizontal: false, vertical: true)
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .pointingHand()
    .accessibilityAddTraits(done ? .isSelected : [])
  }
}
