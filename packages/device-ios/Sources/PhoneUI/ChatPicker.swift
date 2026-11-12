import DeviceCore
import DeviceKit
import PhoneCore
import SwiftUI

/// The phone's own chats, as the Mac window's switcher lists its own, each
/// under where it lives: with KOS at the root, in a project, or a blob's.
/// A new chat on top; the one shown marked. Under it, the few artifacts
/// changed last, to open and read: what KOS made is one tap from the chat
/// it was asked in, and All artifacts goes to the Artifacts tab.
struct ChatPicker: View {
  @ObservedObject var chat: ChatModel
  @ObservedObject var shelf: ArtifactShelf
  var now: Date = Date()
  /// The chat picked, or nil for a new one.
  let pick: (String?) -> Void
  /// An artifact picked, to open.
  let read: (ArtifactItem) -> Void
  /// Every artifact, on the Artifacts tab.
  let all: () -> Void

  /// How many artifacts the picker offers: the last few, under the new chat, so the chats stay in reach.
  static let artifactsShown = 3

  /// The chats by where they live: KOS first, then each project, then each blob, in the order KOS gave them.
  static func groups(_ chats: [ChatModel.Pick]) -> [(title: String, kind: String?, chats: [ChatModel.Pick])] {
    var order: [ChatModel.Place] = []
    var by: [ChatModel.Place: [ChatModel.Pick]] = [:]
    for pick in chats {
      let place = pick.place ?? .kos
      if by[place] == nil { order.append(place) }
      by[place, default: []].append(pick)
    }
    let rank: (ChatModel.Place) -> Int = {
      switch $0 {
      case .kos: 0
      case .project: 1
      case .blob: 2
      }
    }
    return order.enumerated().sorted { (rank($0.element), $0.offset) < (rank($1.element), $1.offset) }.map { _, place in
      (title(place), kind(place), by[place] ?? [])
    }
  }

  private static func kind(_ place: ChatModel.Place) -> String? {
    switch place {
    case .kos: nil
    case .project: "Project"
    case .blob: "Blob"
    }
  }

  private static func title(_ place: ChatModel.Place) -> String {
    switch place {
    case .kos: "KOS"
    case .project(let name): name
    case .blob(let name): name
    }
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        Text("Chats").font(.kos(.title, .semibold))
        Button { pick(nil) } label: {
          HStack(spacing: 12) {
            Tile("square.and.pencil", tint: Theme.accent)
            Text("New chat").font(.kos(.body, .semibold)).foregroundStyle(Theme.accent)
            Spacer()
          }
          .frame(minHeight: 44)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        if !shelf.recent.isEmpty {
          KOSSection("Recent artifacts") {
            Card(padding: EdgeInsets(top: 4, leading: 4, bottom: 4, trailing: 4), spacing: 0) {
              ForEach(shelf.recent.prefix(Self.artifactsShown)) { item in
                ArtifactRow(item: item, now: now) { read(item) }
              }
              if shelf.recent.count > Self.artifactsShown {
                MenuRow(height: 48, action: all) { _ in
                  HStack(spacing: 10) {
                    Tile("square.grid.2x2", tint: Theme.muted, small: true)
                    Text("All artifacts").font(.kos(.body))
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.faint)
                  }
                }
                .accessibilityLabel("All artifacts")
                .accessibilityHint("Opens the Artifacts tab")
              }
            }
          }
        }
        if chat.chats.isEmpty {
          Text("Loading your chats").font(.kos(.dense)).foregroundStyle(Theme.faint)
        }
        ForEach(Self.groups(chat.chats), id: \.title) { group in
          KOSSection(group.title, trailing: {
            if let kind = group.kind { Text(kind).font(.kos(.tiny, .medium)).foregroundStyle(Theme.faint) }
          }) {
            Card(padding: EdgeInsets(top: 4, leading: 4, bottom: 4, trailing: 4), spacing: 0) {
              ForEach(group.chats) { pick in
                MenuRow(on: pick.id == chat.conversation, height: 48, action: { self.pick(pick.id) }) { _ in
                  HStack(spacing: 8) {
                    Text(pick.title).font(.kos(.body)).lineLimit(1).truncationMode(.tail)
                    Spacer(minLength: 8)
                    Text(ChatTime.relative(pick.updated, now: now)).font(.kos(.tiny)).monospacedDigit().foregroundStyle(Theme.faint)
                  }
                }
                .accessibilityLabel("\(pick.title)\(pick.id == chat.conversation ? ", shown" : "")")
              }
            }
          }
        }
      }
      .padding(.horizontal, 20)
      .padding(.top, 24)
      .padding(.bottom, 20)
    }
    .background(Theme.panel)
  }
}

/// One artifact to open, as the chats sheet and the full list draw it: its kind's mark, its title and its age.
struct ArtifactRow: View {
  let item: ArtifactItem
  let now: Date
  let open: () -> Void

  var body: some View {
    MenuRow(height: 48, action: open) { _ in
      HStack(spacing: 10) {
        Tile(ArtifactKindMark.symbol(item.kind), tint: Theme.violet, small: true)
        Text(item.title).font(.kos(.body)).lineLimit(1).truncationMode(.tail)
        Spacer(minLength: 8)
        Text(ChatTime.relative(Date(timeIntervalSince1970: item.updatedAt / 1000), now: now)).font(.kos(.tiny)).monospacedDigit().foregroundStyle(Theme.faint)
      }
    }
    .accessibilityLabel("\(ArtifactKindMark.word(item.kind)): \(item.title)")
    .accessibilityHint("Opens it to read")
  }
}
