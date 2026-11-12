import DeviceKit
import PhoneCore
import SwiftUI

/// The phone's own chats, as the Mac window's switcher lists its own, each
/// under where it lives: with KOS at the root, in a project, or a blob's.
/// A new chat on top; the one shown marked.
struct ChatPicker: View {
  @ObservedObject var chat: ChatModel
  var now: Date = Date()
  /// The chat picked, or nil for a new one.
  let pick: (String?) -> Void

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
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 20)
    .padding(.top, 24)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    .background(Theme.panel)
  }
}
