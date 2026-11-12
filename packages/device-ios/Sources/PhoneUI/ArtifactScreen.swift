import DeviceCore
import DeviceKit
import PhoneCore
import SwiftUI

/// One of the owner's artifacts, full screen, to read: its kind, title and
/// owner in a bar with Close, then the artifact as the dashboard draws it
/// (ArtifactFrame), read-only. A deck moves slide to slide by its own
/// swipes and taps, a sheet scrolls its grid sideways, a doc reads at the
/// phone's width; each follows the phone's light and dark as its own theme
/// handling allows. Nothing here edits, shares or sends.
struct ArtifactScreen<Frame: View>: View {
  @ObservedObject var shelf: ArtifactShelf
  let close: () -> Void
  /// The artifact drawn, in the phone's theme, a deck's controls held apart: the web view on a phone, a picture of
  /// one in a render.
  @ViewBuilder let frame: (ArtifactShelf.Artifact, Bool, DeckRemote) -> Frame
  var now: Date = Date()
  @StateObject private var deck = DeckRemote()
  @Environment(\.colorScheme) private var scheme

  init(shelf: ArtifactShelf, close: @escaping () -> Void, now: Date = Date(), deck: DeckRemote? = nil, @ViewBuilder frame: @escaping (ArtifactShelf.Artifact, Bool, DeckRemote) -> Frame) {
    self.shelf = shelf
    self.close = close
    self.now = now
    self.frame = frame
    _deck = StateObject(wrappedValue: deck ?? DeckRemote())
  }

  /// The dashboard's gutter around a frame on a narrow screen, and its room under the head (artifactcheck.ts, GUTTER).
  static var gutter: CGFloat { 16 }
  static var above: CGFloat { 12 }

  var body: some View {
    VStack(spacing: 0) {
      if let shown = shelf.shown {
        ArtifactBar(shown: shown, now: now, close: close)
        Hairline()
        content(shown)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
    .background(Theme.bg.ignoresSafeArea())
  }

  @ViewBuilder
  private func content(_ shown: ArtifactShelf.Shown) -> some View {
    switch shown {
    case .open(let artifact):
      // In the gutter the dashboard's column gives every frame, above the home indicator, as the deck's bar is.
      let framed = frame(artifact, scheme == .dark, deck)
        .padding(.horizontal, Self.gutter)
        .padding(.top, Self.above)
        .accessibilityLabel(artifact.title)
      if artifact.kind == "deck", let place = deck.place {
        VStack(spacing: 0) {
          framed
          Hairline()
          DeckBar(place: place, press: deck.press)
        }
      } else {
        framed
      }
    case .loading:
      VStack(spacing: 10) {
        ProgressView().controlSize(.regular)
        Text("Opening").font(.kos(.dense)).foregroundStyle(Theme.muted)
      }
      .accessibilityElement(children: .combine)
    case .failed(let id, let title, let why):
      VStack(spacing: 12) {
        Tile("exclamationmark.triangle", tint: Theme.warn)
        Text("It did not open").font(.kos(.title, .semibold))
        Text(why).font(.kos(.dense)).foregroundStyle(Theme.muted).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
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
  init(shelf: ArtifactShelf, openLink: @escaping (URL) -> Void, close: @escaping () -> Void) {
    self.init(shelf: shelf, close: close) { artifact, dark, deck in
      ArtifactWebFrame(artifact: artifact, dark: dark, shelf: shelf, deck: deck, openLink: openLink)
    }
  }
}

/// The web view over the shelf: its reads go to KOS, another artifact it opens opens here.
struct ArtifactWebFrame: View {
  let artifact: ArtifactShelf.Artifact
  let dark: Bool
  let shelf: ArtifactShelf
  let deck: DeckRemote
  let openLink: (URL) -> Void

  var body: some View {
    ArtifactFrame(
      artifact: artifact, dark: dark,
      read: { method, args, answer in shelf.read(method, args: args, answer: answer) },
      open: { id in shelf.open(id, dark: dark) }, openLink: openLink, deck: deck)
  }
}

/// A deck's controls under its slide, the dashboard's head's on a phone: back, where it is, and on, at the thumb.
/// A swipe or a tap on the slide moves it too.
struct DeckBar: View {
  let place: DeckRemote.Place
  let press: (String) -> Void

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
    .padding(.vertical, 8)
    .background(Theme.bg)
  }
}

/// The viewer's bar: the kind's mark, the title over its kind, owner and age, and Close at the thumb.
struct ArtifactBar: View {
  let shown: ArtifactShelf.Shown
  let now: Date
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

  static func owner(_ place: ChatModel.Place) -> String {
    switch place {
    case .kos: "KOS"
    case .project(let name), .blob(let name): name
    }
  }
}
