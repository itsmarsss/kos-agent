import DeviceCore
import DeviceKit
import PhoneCore
import SwiftUI

/// The phone's own chats, as the Mac window's switcher lists its own, each
/// under where it lives: with KOS at the root, in a project, or a blob's.
/// A new chat on top; the one shown marked. Under it, the few artifacts
/// changed last, to open and read: what KOS made is one tap from the chat
/// it was asked in, with no more buttons in the chat's own bar.
struct ChatPicker: View {
  @ObservedObject var chat: ChatModel
  @ObservedObject var shelf: ArtifactShelf
  var now: Date = Date()
  /// The chat picked, or nil for a new one.
  let pick: (String?) -> Void
  /// An artifact picked, to open.
  let read: (ArtifactItem) -> Void

  /// How many artifacts the picker offers: the last few, under the new chat, so the chats stay in reach.
  static let artifactsShown = 3
  /// Every artifact KOS listed, in place of the chats, with a way back.
  @State var showingAll = false

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
    if showingAll {
      AllArtifacts(shelf: shelf, now: now, back: { showingAll = false }, read: read)
    } else {
      chats
    }
  }

  private var chats: some View {
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
                MenuRow(height: 48, action: { showingAll = true }) { _ in
                  HStack(spacing: 10) {
                    Tile("square.grid.2x2", tint: Theme.muted, small: true)
                    Text("All artifacts").font(.kos(.body))
                    Spacer(minLength: 8)
                    Text("\(shelf.recent.count)").font(.kos(.tiny)).monospacedDigit().foregroundStyle(Theme.faint)
                    Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.faint)
                  }
                }
                .accessibilityLabel("All artifacts, \(shelf.recent.count)")
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

/// Every artifact KOS listed, the latest changed first, under when each was changed: today, this week, earlier.
struct AllArtifacts: View {
  @ObservedObject var shelf: ArtifactShelf
  let now: Date
  let back: () -> Void
  let read: (ArtifactItem) -> Void

  /// The artifacts by how long ago they changed, in KOS's order within each.
  static func groups(_ items: [ArtifactItem], now: Date, calendar: Calendar = .current) -> [(title: String, items: [ArtifactItem])] {
    let today = calendar.startOfDay(for: now)
    let week = calendar.date(byAdding: .day, value: -6, to: today) ?? today
    let sorted = items.sorted { $0.updatedAt > $1.updatedAt }
    let at = { (i: ArtifactItem) in Date(timeIntervalSince1970: i.updatedAt / 1000) }
    return [
      ("Today", sorted.filter { at($0) >= today }),
      ("This week", sorted.filter { at($0) < today && at($0) >= week }),
      ("Earlier", sorted.filter { at($0) < week }),
    ].filter { !$0.1.isEmpty }
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        HStack(spacing: 6) {
          // A thumb's 44 points, though it is drawn beside the title, as the sheet's other titles sit.
          Button(action: back) {
            Image(systemName: "chevron.left").font(.kos(.title, .semibold)).foregroundStyle(Theme.accent)
              .frame(width: 22, height: 44, alignment: .leading)
              .contentShape(Rectangle().inset(by: -11))
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Back to the chats")
          Text("Artifacts").font(.kos(.title, .semibold))
        }
        .padding(.top, -10)
        ForEach(Self.groups(shelf.recent, now: now), id: \.title) { group in
          KOSSection(group.title) {
            Card(padding: EdgeInsets(top: 4, leading: 4, bottom: 4, trailing: 4), spacing: 0) {
              ForEach(group.items) { item in ArtifactRow(item: item, now: now) { read(item) } }
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

/// The little there is to set on the phone: speak replies, and which KOS it is paired with, to unpair.
struct MoreSheet: View {
  @ObservedObject var phone: Phone
  @ObservedObject var reader: ReplyReader
  let close: () -> Void
  @State private var confirming = false

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack(spacing: 12) {
        KOSFace(size: 44, mood: phone.chat.online ? .idle : BlobMood(link: phone.chat.link), look: phone.chat.face)
        RowText(phone.paired?.name ?? "iPhone", phone.paired.map { "Paired with KOS at \((try? $0.kosAddress().display) ?? $0.address)" }, size: .body, detailLines: 2)
      }
      Card {
        SwitchRow("Speak replies", "Read KOS's answers aloud as they land.", isOn: reader.on) { reader.on = $0 }
      }
      if confirming {
        Card(tone: Theme.danger) {
          RowText("Unpair this iPhone?", "KOS forgets it, and it forgets KOS. Pairing again needs a new code.", size: .control)
          HStack(spacing: 10) {
            Button("Keep it") { confirming = false }.buttonStyle(KOSButtonStyle(.secondary, large: true))
            Button("Unpair") {
              close()
              phone.unpair()
            }
            .buttonStyle(KOSButtonStyle(.danger, large: true))
          }
        }
      } else {
        Button("Unpair this iPhone") { confirming = true }.buttonStyle(KOSButtonStyle(.danger, large: true))
      }
    }
    .padding(.horizontal, 20)
    .padding(.top, 24)
    .padding(.bottom, 16)
    .fixedSize(horizontal: false, vertical: true)
    .background(GeometryReader { box in Color.clear.preference(key: FitHeight.self, value: box.size.height) })
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    .background(Theme.panel)
  }
}

/// How tall a sheet's content is, so the sheet can stop there rather than at half the screen.
struct FitHeight: PreferenceKey {
  static let defaultValue: CGFloat = 0
  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}
