import DeviceCore
import DeviceKit
import SwiftUI

/// The chat's words, as the Mac's window draws them (DeviceKit's Bubble,
/// ChatMarkdown and Steps): the owner's on the right, KOS's on the page,
/// each turn's steps folded to a chip. A running turn ends in its foot, with
/// Stop beside it, and an ask in a line that opens its sheet.
struct Thread: View {
  @ObservedObject var chat: ChatModel
  let review: () -> Void
  @Environment(\.accessibilityReduceMotion) private var still

  var body: some View {
    ScrollViewReader { reader in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          if chat.lines.isEmpty && chat.sending.isEmpty && chat.notices.isEmpty {
            EmptyThread(online: chat.usable) { chat.say($0) }
          }
          ForEach(chat.items) { item in
            ItemView(item: item, chat: chat)
          }
          if let foot = chat.foot {
            Foot(what: foot, since: chat.workingSince ?? Date(), live: chat.footLive, stop: chat.stop)
          }
          ForEach(chat.asks) { ask in AskLine(ask: ask, review: review) }
          Color.clear.frame(height: 1).id("end")
        }
        .padding(.horizontal, 16)
        .padding(.top, 16)
        .padding(.bottom, 12)
        .textSelection(.enabled)
      }
      .scrollIndicators(.hidden)
      .scrollDismissesKeyboard(.interactively)
      .onChange(of: chat.items.count) { end(reader) }
      .onChange(of: chat.stories) { end(reader) }
      .onChange(of: chat.asks.count) { end(reader) }
      .onAppear { reader.scrollTo("end", anchor: .bottom) }
    }
  }

  private func end(_ reader: ScrollViewProxy) {
    withAnimation(still ? nil : Theme.spring) { reader.scrollTo("end", anchor: .bottom) }
  }
}

/// One thing in the thread.
private struct ItemView: View {
  let item: ChatModel.Item
  @ObservedObject var chat: ChatModel

  var body: some View {
    switch item {
    case .line(_, let line):
      switch line {
      case .you(let text, let files, let quote): Bubble(text: text, files: files, quote: quote)
      case .kos(let text): ChatMarkdown(text).frame(maxWidth: .infinity, alignment: .leading)
      case .note(let text):
        Text(text).font(.kos(.tiny)).foregroundStyle(Theme.faint).multilineTextAlignment(.center).frame(maxWidth: .infinity)
      case .steps(let steps): Steps(steps: steps, pictures: chat.picturesOf(steps.map(\.frame)))
      }
    case .notice(_, let notice):
      VStack(alignment: .leading, spacing: 2) {
        if let from = notice.from { Text(from).font(.kos(.tiny, .semibold)).foregroundStyle(Theme.violet) }
        ChatMarkdown(notice.text)
      }
    case .sending(_, let text):
      Bubble(text: text, files: chat.sendingFiles[text] ?? []).opacity(0.6).accessibilityLabel("Sending: \(text)")
    case .story(_, let story):
      // A turn on the go: its steps so far, live, and what KOS is saying after them, streamed.
      let told = ChatModel.read(story.text)
      if !told.steps.isEmpty { Steps(steps: told.steps, live: true, pictures: chat.picturesOf(chat.liveFrames(of: story.said))) }
      if !told.words.isEmpty { ChatMarkdown(told.words).foregroundStyle(Theme.muted) }
    }
  }
}

/// The foot of a running turn, the kit's Working, with Stop for the thumb: it ends the turn on KOS.
private struct Foot: View {
  let what: String
  let since: Date
  let live: Bool
  let stop: () -> Void

  var body: some View {
    HStack(spacing: 8) {
      Working(what: what, since: since, live: live)
      Spacer(minLength: 8)
      Button(action: stop) {
        Label("Stop", systemImage: "stop.fill").labelStyle(.titleAndIcon)
      }
      .buttonStyle(KOSButtonStyle(.danger, capsule: true))
      .frame(minHeight: 44)
      .accessibilityLabel("Stop KOS")
      .accessibilityHint("Ends the turn KOS is running")
    }
  }
}

/// An ask, in the thread where it was asked: one line, and a tap opens it to decide.
private struct AskLine: View {
  let ask: ChatModel.Ask
  let review: () -> Void

  var body: some View {
    Button(action: review) {
      Card(tone: Theme.warn, padding: EdgeInsets(top: 10, leading: 12, bottom: 10, trailing: 12)) {
        HStack(spacing: 10) {
          Tile("hand.raised.fill", tint: Theme.warn, small: true)
          RowText("KOS asks to run \(ask.tool)", ask.why ?? ask.reason ?? "Waiting on you", size: .control, titleLines: 1, detailLines: 2)
          Spacer(minLength: 6)
          Text("Review").font(.kos(.control, .semibold)).foregroundStyle(Theme.accent)
        }
      }
    }
    .buttonStyle(.plain)
    .accessibilityLabel("KOS asks to run \(ask.tool). \(ask.why ?? ask.reason ?? "")")
    .accessibilityHint("Opens it to approve or deny")
  }
}

/// Nothing said yet: KOS's face, what to do, and a few things to ask.
private struct EmptyThread: View {
  let online: Bool
  let ask: (String) -> Void

  static let suggestions = ["What's on today?", "What are you working on?", "Remind me at 5 to call Sam"]

  var body: some View {
    VStack(spacing: 12) {
      KOSFace(size: 72, mood: online ? .idle : .asleep)
        .padding(.top, 40)
      Text("Ask KOS anything").font(.kos(.title, .semibold))
      Text("Press the microphone and speak, or type.")
        .font(.kos(.dense))
        .foregroundStyle(Theme.muted)
        .multilineTextAlignment(.center)
      if online {
        // Each a thumb's height to press, so the rows need no gap of their own.
        VStack(spacing: 0) {
          ForEach(Self.suggestions, id: \.self) { words in
            Button(words) { ask(words) }
              .buttonStyle(KOSButtonStyle(.secondary, capsule: true))
              .frame(minHeight: 44)
              .contentShape(Rectangle())
          }
        }
        .padding(.top, 6)
      }
    }
    .frame(maxWidth: .infinity)
    .padding(.horizontal, 24)
  }
}
