import DeviceCore
import DeviceKit
import PhoneCore
import SwiftUI

/// The Chat tab: KOS's face and the chat's name at the top, opening the
/// chats, with what waits on the owner and a new chat beside them; the
/// thread, its steps folded; and the voice-first box at the foot, over the
/// tabs. The glance grew into the overview, and the settings went to More.
public struct ChatScreen: View {
  @ObservedObject private var phone: Phone
  @ObservedObject private var chat: ChatModel
  @State private var sheet: Sheet?
  /// The asks already seen, so a new one brings its sheet up by itself once.
  @State private var seenAsks: Set<String> = []
  /// An artifact picked in the chats sheet, opened once the sheet has gone.
  @State private var reading: ArtifactItem?
  @Environment(\.accessibilityReduceMotion) private var still
  @Environment(\.colorScheme) private var scheme
  @Environment(\.showTab) private var showTab

  enum Sheet: String, Identifiable {
    case ask, chats
    var id: String { rawValue }
  }

  public init(phone: Phone) {
    self.phone = phone
    chat = phone.chat
  }

  public var body: some View {
    VStack(spacing: 0) {
      ChatHeader(chat: chat, open: open)
      Hairline()
      if let line = LineBanner.words(chat) { LineBanner(words: line, tone: chat.link == .connecting ? .muted : .warn) }
      Thread(chat: chat, review: { open(.ask) })
        // An artifact KOS names in its words opens here at a tap, to read.
        .environment(\.chatOpensArtifacts, true)
        .environment(\.openURL, OpenURLAction { url in
          guard let id = ArtifactLink.id(url) else { return .systemAction }
          phone.artifacts.open(id, dark: scheme == .dark)
          return .handled
        })
    }
    // The chat's words at the dashboard's size, as the Mac's window sets them.
    .font(.kos(.body))
    .safeAreaInset(edge: .bottom, spacing: 0) {
      Composer(chat: chat, voice: phone.voice, tray: phone.tray)
    }
    .sheet(item: $sheet, onDismiss: openPicked) { which in
      sheetBody(which)
        .presentationBackground(Theme.panel)
        .presentationDragIndicator(.visible)
    }
    .onChange(of: chat.asks.map(\.id)) { _, ids in
      // An ask that arrives brings its sheet up, once: one tap from the owner decides it.
      let fresh = Set(ids).subtracting(seenAsks)
      seenAsks.formUnion(ids)
      if !fresh.isEmpty, sheet == nil { sheet = .ask }
      if ids.isEmpty, sheet == .ask { sheet = nil }
    }
  }

  private func open(_ which: Sheet) {
    if which == .chats {
      chat.list()
      phone.artifacts.list()
    }
    sheet = which
  }

  private func openPicked() {
    guard let item = reading else { return }
    reading = nil
    phone.artifacts.open(item.id, title: item.title, dark: scheme == .dark)
  }

  @ViewBuilder
  private func sheetBody(_ which: Sheet) -> some View {
    switch which {
    case .ask:
      ApprovalSheet(chat: chat) { sheet = nil }
        .presentationDetents([.medium, .large])
    case .chats:
      ChatPicker(chat: chat, shelf: phone.artifacts) { id in
        sheet = nil
        if let id { chat.switchTo(id) } else { chat.say("/new") }
      } read: { item in
        reading = item
        sheet = nil
      } all: {
        sheet = nil
        showTab(.artifacts)
      }
      .presentationDetents([.medium, .large])
    }
  }
}

/// KOS's face and the chat's name, opening the chats; what waits on the owner in this chat, and a new chat.
struct ChatHeader: View {
  @ObservedObject var chat: ChatModel
  let open: (ChatScreen.Sheet) -> Void

  private var mood: BlobMood {
    guard chat.online else { return BlobMood(link: chat.link) }
    return chat.asks.isEmpty ? (chat.working ? .working : .idle) : .needsYou
  }

  /// The chat's name under KOS, or what the line is doing.
  private var subtitle: String {
    if chat.silent { return "Cannot talk here yet" }
    switch chat.link {
    case .connected: return chat.conversation == nil ? "New chat" : chat.title
    case .connecting: return "Connecting"
    default: return "Not connected"
    }
  }

  var body: some View {
    HStack(spacing: 10) {
      Button { open(.chats) } label: {
        HStack(spacing: 10) {
          KOSFace(size: 36, mood: mood, look: chat.face)
          VStack(alignment: .leading, spacing: 1) {
            Text("KOS").font(.kos(.title, .semibold)).foregroundStyle(Theme.text)
            HStack(spacing: 4) {
              Text(subtitle).lineLimit(1).truncationMode(.tail)
              Image(systemName: "chevron.down").font(.system(size: 9, weight: .bold))
            }
            .font(.kos(.detail))
            .foregroundStyle(Theme.muted)
          }
        }
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(!chat.usable)
      .accessibilityLabel("Chat: \(subtitle)")
      .accessibilityHint("Shows your chats")
      if !chat.asks.isEmpty {
        HeaderButton(symbol: "hand.raised.fill", label: "\(chat.asks.count) waiting on you", tint: Theme.warn, count: chat.asks.count) { open(.ask) }
      }
      HeaderButton(symbol: "square.and.pencil", label: "New chat") { chat.say("/new") }
        .disabled(!chat.usable)
    }
    .padding(.leading, 16)
    .padding(.trailing, 8)
    .padding(.vertical, 6)
  }
}

/// A round button in the header, 44 points to the thumb: a symbol, and a dot or a count over it when it has news.
struct HeaderButton: View {
  let symbol: String
  let label: String
  var tint: Color = Theme.muted
  var mark: Color? = nil
  var count: Int? = nil
  let action: () -> Void
  @Environment(\.isEnabled) private var enabled

  var body: some View {
    Button(action: action) {
      Image(systemName: symbol)
        .font(.kos(.title, .medium))
        .foregroundStyle(enabled ? tint : Theme.faint)
        .frame(width: 44, height: 44)
        .overlay(alignment: .topTrailing) {
          if let count {
            Text("\(count)")
              .font(.kos(.tiny, .bold).monospacedDigit())
              .foregroundStyle(Theme.onAccent)
              .padding(.horizontal, 5)
              .frame(minWidth: 18, minHeight: 18)
              .background(Theme.warn, in: Capsule())
              .offset(x: -2, y: 4)
          } else if let mark {
            Dot(mark, size: 8).offset(x: -10, y: 10)
          }
        }
        .contentShape(Circle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(label)
  }
}

/// Why the chat cannot be talked to right now, in a line under the header.
struct LineBanner: View {
  let words: String
  let tone: Pill.Tone

  static func words(_ chat: ChatModel) -> String? {
    if chat.silent { return "This KOS cannot talk to phones yet. Update KOS and restart it." }
    switch chat.link {
    case .connecting: return "Connecting to KOS…"
    case .offline(let why): return "Not connected. \(why)"
    case .untrusted: return "Something answered that is not your KOS. Nothing was sent to it."
    case .replaced: return "Another copy of this app took the line."
    case .outdated: return "KOS speaks another version of the device protocol. Update this app or KOS."
    case .disconnected: return "Disconnected."
    case .connected, nil: return nil
    }
  }

  var body: some View {
    HStack(spacing: 8) {
      Dot(tone == .warn ? Theme.warn : Theme.muted)
      Text(words).font(.kos(.detail)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 8)
    .background(Theme.panel)
    .accessibilityElement(children: .combine)
  }
}
