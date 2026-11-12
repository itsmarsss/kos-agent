import DeviceCore
import DeviceKit
import PhoneCore
import SwiftUI

/// The pieces every page the phone browses is drawn from, so the Inbox, the
/// projects, the artifacts and the rest read as one app: a head the size of
/// the chat's, a list on the app's ground with hairlines between its rows,
/// a search field, and what a page says while it loads, when it is empty and
/// when it failed.

/// A page's head: back when it was opened from another, the title, and a control or two at the right, 56 high as the
/// chat's head is.
struct PageHead<Trailing: View>: View {
  let title: String
  var detail: String? = nil
  var back: (() -> Void)? = nil
  @ViewBuilder var trailing: () -> Trailing

  var body: some View {
    HStack(spacing: 4) {
      if let back {
        HeaderButton(symbol: "chevron.left", label: "Back", tint: Theme.accent, action: back)
      }
      VStack(alignment: .leading, spacing: 1) {
        Text(title).font(.kos(.title, .semibold)).lineLimit(1).truncationMode(.tail)
        if let detail { Text(detail).font(.kos(.detail)).foregroundStyle(Theme.muted).lineLimit(1) }
      }
      .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
      .padding(.leading, back == nil ? 8 : 0)
      .accessibilityElement(children: .combine)
      .accessibilityAddTraits(.isHeader)
      trailing()
    }
    .padding(.leading, 8)
    .padding(.trailing, 8)
    .padding(.vertical, 6)
  }
}

extension PageHead where Trailing == EmptyView {
  init(title: String, detail: String? = nil, back: (() -> Void)? = nil) {
    self.init(title: title, detail: detail, back: back) { EmptyView() }
  }
}

/// A page: its head over a hairline, then its body, on the app's ground.
struct PageFrame<Head: View, Content: View>: View {
  @ViewBuilder let head: () -> Head
  @ViewBuilder let content: () -> Content

  var body: some View {
    VStack(spacing: 0) {
      head()
      Hairline()
      content().frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    .background(Theme.bg)
  }
}

/// Rows on the app's ground, as a list: a thumb's swipe and a long press work on them as on any iPhone list, a pull
/// reads the page again, and the last row clears the tab bar.
struct PageList<Content: View>: View {
  let refresh: () async -> Void
  @ViewBuilder let content: () -> Content

  var body: some View {
    List {
      content()
    }
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .environment(\.defaultMinListRowHeight, 1)
    #if os(macOS)
      // A Mac's list sets its rows 8 points further in than an iPhone's: taken back, so the phone's gutter is drawn.
      .padding(.horizontal, -8)
    #endif
    .background(Theme.bg)
    .refreshable { await refresh() }
  }
}

extension View {
  /// A row of a page's list, on the ground, with the app's gutter and a hairline under it.
  func pageRow(separator: Bool = true) -> some View {
    listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
      .listRowBackground(Theme.bg)
      .listRowSeparator(separator ? .visible : .hidden)
      .listRowSeparatorTint(Theme.line)
  }
}

/// A group's name in a list, as a section's label over its rows: the kit's label, with a count.
struct GroupHead: View {
  let title: String
  var count: Int? = nil

  var body: some View {
    HStack(spacing: 6) {
      SectionLabel(title)
      if let count { Text("\(count)").font(.kos(.tiny, .semibold).monospacedDigit()).foregroundStyle(Theme.faint) }
      Spacer(minLength: 0)
    }
    .padding(.top, 18)
    .padding(.bottom, 6)
    .accessibilityAddTraits(.isHeader)
  }
}

/// One row: a tile, its words, and what sits at its right, a thumb's height at least.
struct PageRowLabel<Trailing: View>: View {
  let symbol: String
  let tint: Color
  let title: String
  var detail: String? = nil
  var detailLines = 1
  var opens = false
  @ViewBuilder var trailing: () -> Trailing

  var body: some View {
    HStack(spacing: 12) {
      Tile(symbol, tint: tint)
      RowText(title, detail, size: .body, titleLines: 1, detailLines: detailLines)
        .frame(maxWidth: .infinity, alignment: .leading)
      trailing()
      if opens {
        Image(systemName: "chevron.right").font(.kos(.detail, .semibold)).foregroundStyle(Theme.faint)
      }
    }
    .padding(.vertical, 10)
    .frame(minHeight: 56)
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
  }
}

extension PageRowLabel where Trailing == EmptyView {
  init(symbol: String, tint: Color, title: String, detail: String? = nil, detailLines: Int = 1, opens: Bool = false) {
    self.init(symbol: symbol, tint: tint, title: title, detail: detail, detailLines: detailLines, opens: opens) { EmptyView() }
  }
}

/// A time at a row's right, small and quiet, as the chats list says it.
struct RowTime: View {
  let at: Double
  let now: Date

  var body: some View {
    Text(ChatTime.relative(at.at, now: now)).font(.kos(.tiny)).monospacedDigit().foregroundStyle(Theme.faint)
  }
}

/// A field to search a page by: the magnifier, the words, and a cross to clear them, one height with the chips beside.
struct SearchField: View {
  let prompt: String
  @Binding var text: String

  static let height: CGFloat = 40

  var body: some View {
    HStack(spacing: 8) {
      Image(systemName: "magnifyingglass").font(.kos(.dense, .medium)).foregroundStyle(Theme.faint)
      TextField("", text: $text)
        .textFieldStyle(.plain)
        .font(.kos(.body))
        .autocorrectionDisabled()
        .overlay(alignment: .leading) {
          if text.isEmpty { Text(prompt).font(.kos(.body)).foregroundStyle(Theme.faint).allowsHitTesting(false) }
        }
        .accessibilityLabel(prompt)
      if !text.isEmpty {
        Button { text = "" } label: {
          Image(systemName: "xmark.circle.fill").font(.kos(.body)).foregroundStyle(Theme.faint).frame(width: 28, height: Self.height)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Clear the search")
      }
    }
    .padding(.leading, 12)
    .padding(.trailing, text.isEmpty ? 12 : 4)
    .frame(height: Self.height)
    .background(Theme.panel, in: RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous).strokeBorder(Theme.line))
  }
}

/// A few choices in a row that scrolls sideways when they do not fit: a page's filters, the kit's chips.
struct FilterChips<Value: Hashable>: View {
  let options: [(value: Value?, label: String)]
  let selected: Value?
  let choose: (Value?) -> Void

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 6) {
        ForEach(Array(options.enumerated()), id: \.offset) { _, option in
          Button { choose(option.value) } label: { Text(option.label) }
            .buttonStyle(ChipStyle(selected: option.value == selected))
            .frame(minHeight: 44)
        }
      }
      .padding(.horizontal, 16)
    }
    .scrollClipDisabled()
  }
}

/// What a page says when it has nothing to show: loading, empty, or why it could not be read, with a way to try again.
struct PageNote: View {
  enum Kind {
    case loading(String)
    case empty(symbol: String, title: String, detail: String)
    case failed(String, retry: () async -> Void)
  }

  let kind: Kind

  var body: some View {
    VStack(spacing: 10) {
      switch kind {
      case .loading(let words):
        ProgressView().controlSize(.regular)
        Text(words).font(.kos(.dense)).foregroundStyle(Theme.muted)
      case .empty(let symbol, let title, let detail):
        Tile(symbol, tint: Theme.muted)
        Text(title).font(.kos(.body, .semibold))
        Text(detail).font(.kos(.dense)).foregroundStyle(Theme.muted)
      case .failed(let why, let retry):
        Tile("exclamationmark.triangle", tint: Theme.warn)
        Text("Couldn't load this").font(.kos(.body, .semibold))
        Text(why).font(.kos(.dense)).foregroundStyle(Theme.muted)
        Button("Try again") { Task { await retry() } }
          .buttonStyle(KOSButtonStyle(.secondary, capsule: true))
          .frame(minHeight: 44)
      }
    }
    .multilineTextAlignment(.center)
    .fixedSize(horizontal: false, vertical: true)
    .padding(.horizontal, 32)
    .padding(.vertical, 40)
    .frame(maxWidth: .infinity)
    .accessibilityElement(children: .combine)
  }
}

/// A page read over the line, drawn as what it has: its rows once it has them, or what it says while it has none.
struct Loaded<Value: Sendable, Content: View>: View {
  @ObservedObject var page: Page<Value>
  let loading: String
  @ViewBuilder let content: (Value) -> Content

  var body: some View {
    if let value = page.value {
      content(value)
    } else if let error = page.error {
      PageList(refresh: page.refresh) {
        PageNote(kind: .failed(error, retry: page.refresh)).pageRow(separator: false)
      }
    } else {
      PageNote(kind: .loading(loading)).frame(maxHeight: .infinity)
    }
  }
}

/// The line over a page's rows when the last read failed but an older one is still shown.
struct StaleNote: View {
  let error: String

  var body: some View {
    HStack(spacing: 8) {
      Dot(Theme.warn)
      Text("Showing what KOS said last. \(error)").font(.kos(.detail)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
    }
    .padding(.vertical, 8)
  }
}
