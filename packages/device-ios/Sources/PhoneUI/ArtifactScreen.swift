import DeviceCore
import DeviceKit
import PhoneCore
import SwiftUI

/// One of the owner's artifacts, full screen, to read: its kind, title and
/// owner in a bar with Share and Close, then the artifact as the dashboard
/// draws it (ArtifactFrame), read-only, edge to edge on the app's own ground:
/// no box, no inset, no fade, so it reads as the app's page rather than a
/// page set in it. A doc reads at the phone's width; a sheet scrolls its grid
/// sideways under a frozen first column, and a row tapped opens over it,
/// every field labelled. A deck held upright reads as a column of numbered
/// slides; turned on its side it fills the screen a slide at a time, moved by
/// its own swipes and taps or the bar under it, which holds Close there. Each
/// follows the phone's light and dark. Nothing here edits or sends; Share
/// hands an export, as the dashboard makes one, to the share sheet.
struct ArtifactScreen<Frame: View>: View {
  @ObservedObject var shelf: ArtifactShelf
  let close: () -> Void
  /// The artifact drawn, in the phone's theme, a deck's controls held apart: the web view on a phone, a picture of
  /// one in a render.
  @ViewBuilder let frame: (ArtifactShelf.Artifact, Bool, DeckRemote) -> Frame
  var now: Date = Date()
  /// The open one exported in a format its kind has, as a file for the share sheet; none, and there is no Share.
  var export: ((ArtifactShelf.Artifact, String) async -> URL?)?
  @StateObject private var deck = DeckRemote()
  @State private var sharing: Shared?
  @Environment(\.colorScheme) private var scheme
  @Environment(\.verticalSizeClass) private var height

  init(
    shelf: ArtifactShelf, close: @escaping () -> Void, now: Date = Date(), deck: DeckRemote? = nil,
    export: ((ArtifactShelf.Artifact, String) async -> URL?)? = nil, @ViewBuilder frame: @escaping (ArtifactShelf.Artifact, Bool, DeckRemote) -> Frame
  ) {
    self.shelf = shelf
    self.close = close
    self.now = now
    self.export = export
    self.frame = frame
    _deck = StateObject(wrappedValue: deck ?? DeckRemote())
  }

  /// A deck on its side, one slide at a time: the slide takes the screen, with nothing over it but its own bar.
  private var staged: DeckRemote.Place? {
    guard height == .compact, case .open(let artifact) = shelf.shown, artifact.kind == "deck", let place = deck.place, !place.reading else { return nil }
    return place
  }

  var body: some View {
    VStack(spacing: 0) {
      if let shown = shelf.shown {
        if let place = staged, case .open(let artifact) = shown {
          // The slide as large as the screen allows, on the ground, with no frame of its own.
          GeometryReader { box in
            let width = min(box.size.width, box.size.height * 16 / 9)
            frame(artifact, scheme == .dark, deck)
              .frame(width: width, height: width * 9 / 16)
              .frame(maxWidth: .infinity, maxHeight: .infinity)
          }
          .accessibilityLabel(artifact.title)
          Hairline()
          DeckBar(place: place, press: deck.press, close: close)
        } else {
          ArtifactBar(shown: shown, now: now, share: export.map { export in { artifact, format in
            Task { if let url = await export(artifact, format) { sharing = Shared(url: url) } }
          } }, close: close)
          Hairline()
          content(shown)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
      }
    }
    .background(Theme.bg.ignoresSafeArea())
    .sheet(item: $shelf.row) { row in
      RowSheet(row: row)
        .presentationBackground(Theme.panel)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
    .modifier(ShareSheet(shared: $sharing))
  }

  @ViewBuilder
  private func content(_ shown: ArtifactShelf.Shown) -> some View {
    switch shown {
    case .open(let artifact):
      // Edge to edge: the runtime sets the text in the app's gutter on its own ground, which is the app's.
      frame(artifact, scheme == .dark, deck)
        .accessibilityLabel(artifact.title)
    case .loading:
      VStack(spacing: 10) {
        ProgressView().controlSize(.regular)
        Text("Opening").font(.kos(.dense)).foregroundStyle(Theme.muted)
      }
      .accessibilityElement(children: .combine)
    case .failed(let id, let title, _):
      // In the owner's words: why it failed is KOS's account, kept in the log (ArtifactShelf).
      VStack(spacing: 12) {
        Tile("exclamationmark.triangle", tint: Theme.warn)
        Text("Couldn't open this").font(.kos(.title, .semibold))
        Text("KOS couldn't get it ready. Try again, or open it on the dashboard.")
          .font(.kos(.dense)).foregroundStyle(Theme.muted).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
        Button("Try again") { shelf.open(id, title: title, dark: scheme == .dark) }
          .buttonStyle(KOSButtonStyle(.secondary, capsule: true))
          .frame(minHeight: 44)
      }
      .padding(.horizontal, 32)
    }
  }
}

extension ArtifactScreen where Frame == ArtifactWebFrame {
  /// The viewer as a phone draws it, the artifact in its web view.
  init(shelf: ArtifactShelf, close: @escaping () -> Void, export: ((ArtifactShelf.Artifact, String) async -> URL?)?) {
    self.init(shelf: shelf, close: close, export: export) { artifact, dark, deck in
      ArtifactWebFrame(artifact: artifact, dark: dark, shelf: shelf, deck: deck)
    }
  }
}

/// The web view over the shelf: its reads go to KOS, another artifact it opens opens here.
struct ArtifactWebFrame: View {
  let artifact: ArtifactShelf.Artifact
  let dark: Bool
  let shelf: ArtifactShelf
  let deck: DeckRemote

  var body: some View {
    ArtifactFrame(
      artifact: artifact, dark: dark,
      read: { method, args, answer in shelf.read(method, args: args, answer: answer) },
      open: { id in shelf.open(id, dark: dark) }, row: { shelf.tapped($0) }, cannot: { why in shelf.cannotShow(artifact.id, why) }, deck: deck)
  }
}

/// A deck's controls under its slide on its side, the dashboard's head's on a phone: Close, then back, where it is,
/// and on, at the thumb. A swipe or a tap on the slide moves it too.
struct DeckBar: View {
  let place: DeckRemote.Place
  let press: (String) -> Void
  let close: () -> Void

  var body: some View {
    HStack(spacing: 16) {
      RoundButton(symbol: "chevron.left", label: "Previous slide") { press("prev") }
        .disabled(place.index == 0)
      Text("\(place.index + 1) / \(place.count)")
        .font(.kos(.body, .medium).monospacedDigit())
        .frame(minWidth: 64)
        .accessibilityLabel("Slide \(place.index + 1) of \(place.count)")
      RoundButton(symbol: "chevron.right", label: "Next slide") { press("next") }
        .disabled(place.index >= place.count - 1)
    }
    .frame(maxWidth: .infinity)
    .overlay(alignment: .leading) { HeaderButton(symbol: "xmark", label: "Close", action: close) }
    .padding(.horizontal, 8)
    .padding(.vertical, 6)
    .background(Theme.bg)
  }
}

/// The viewer's bar: the kind's mark, the title over its kind, owner and age, then Share, a format a press, and Close
/// at the thumb.
struct ArtifactBar: View {
  let shown: ArtifactShelf.Shown
  let now: Date
  var share: ((ArtifactShelf.Artifact, String) -> Void)? = nil
  let close: () -> Void

  private var detail: String {
    guard case .open(let artifact) = shown else { return "Artifact" }
    return [ArtifactKindMark.word(artifact.kind), artifact.place.map(ArtifactKindMark.owner), artifact.updated.map { ChatTime.relative($0, now: now) }]
      .compactMap { $0 }.joined(separator: " · ")
  }

  private var kind: String? {
    if case .open(let artifact) = shown { return artifact.kind }
    return nil
  }

  var body: some View {
    HStack(spacing: 12) {
      Tile(ArtifactKindMark.symbol(kind), tint: Theme.violet)
      VStack(alignment: .leading, spacing: 1) {
        Text(shown.title ?? shown.id).font(.kos(.title, .semibold)).lineLimit(1).truncationMode(.tail)
        Text(detail).font(.kos(.detail)).foregroundStyle(Theme.muted).lineLimit(1)
      }
      .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
      .accessibilityElement(children: .combine)
      if let share, case .open(let artifact) = shown {
        Menu {
          ForEach(GalleryModel.formats(artifact.kind), id: \.self) { format in
            Button { share(artifact, format) } label: { Label("Share as \(ArtifactKindMark.format(format))", systemImage: "square.and.arrow.up") }
          }
        } label: {
          Image(systemName: "square.and.arrow.up").font(.kos(.title, .medium)).foregroundStyle(Theme.muted).frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .menuStyle(.button)
        .menuIndicator(.hidden)
        .buttonStyle(.plain)
        .fixedSize()
        .accessibilityLabel("Share \(artifact.title)")
      }
      HeaderButton(symbol: "xmark", label: "Close", action: close)
    }
    .padding(.leading, 16)
    .padding(.trailing, 8)
    .padding(.vertical, 6)
  }
}

/// How an artifact's kind is marked and said, on the phone as in the dashboard's gallery.
enum ArtifactKindMark {
  static func symbol(_ kind: String?) -> String {
    switch kind {
    case "doc": "doc.text"
    case "deck": "rectangle.on.rectangle"
    case "sheet": "tablecells"
    default: "square.grid.2x2"
    }
  }

  static func word(_ kind: String) -> String {
    switch kind {
    case "doc": "Doc"
    case "deck": "Deck"
    case "sheet": "Sheet"
    default: "Page"
    }
  }

  /// The kind as a filter names its artifacts.
  static func plural(_ kind: String) -> String {
    "\(word(kind))s"
  }

  /// A format as the share menu names it (artifactexport.ts, EXPORT_WORDS).
  static func format(_ format: String) -> String {
    switch format {
    case "md": "Markdown"
    default: format.uppercased()
    }
  }

  static func owner(_ place: ChatModel.Place) -> String {
    switch place {
    case .kos: "KOS"
    case .project(let name), .blob(let name): name
    }
  }
}
