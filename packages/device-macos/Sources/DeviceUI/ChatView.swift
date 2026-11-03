import SwiftUI

/// KOS Device's chat window: the side panel's chat, floating over the
/// owner's apps (docs/design.md, Chat). KOS's face and the chat's name lead
/// it, the name opening the window's own chats; the thread, then what waits
/// on the owner, then the box, with the app in front, the model and Ask or
/// Auto under it.
/// The chat's type, as the dashboard sets it (docs/design.md, Chat): the side panel and this window read alike.
public enum ChatType {
  /// The words, the owner's and KOS's, and the box they are typed in.
  public static let body: CGFloat = 15
  /// A table's cells.
  public static let table: CGFloat = 14
  /// Code blocks and table heads.
  public static let dense: CGFloat = 13
  /// Chips, the chat's name, notes and asides.
  public static let detail: CGFloat = 12
}

public struct ChatView: View {
  @ObservedObject private var model: ChatModel
  @State private var switching = false
  @FocusState private var typing: Bool

  public static let size = CGSize(width: 380, height: 560)

  public init(model: ChatModel) {
    self.model = model
  }

  public var body: some View {
    VStack(spacing: 0) {
      header
      Rectangle().fill(Theme.line).frame(height: 1)
      thread
      if !model.asks.isEmpty {
        VStack(spacing: 8) {
          ForEach(model.asks) { ask in AskCard(ask: ask, answer: model.answer) }
        }
        .padding(.horizontal, 14)
        .padding(.bottom, 8)
      }
      if let error = model.error {
        Text(error).font(.system(size: ChatType.detail)).foregroundStyle(Theme.danger)
          .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.bottom, 6)
      }
      composer
    }
    .frame(minWidth: 320, minHeight: 380)
    // Up to the window's top edge: its title bar is hidden, and the header is where it is dragged from.
    .ignoresSafeArea(.container, edges: .top)
    .background(Theme.bg)
    .foregroundStyle(Theme.text)
    .font(.system(size: ChatType.body))
    .onAppear { typing = true }
  }

  // MARK: Header

  private var header: some View {
    HStack(spacing: 10) {
      KOSFace(size: 30, mood: model.online ? (model.asks.isEmpty ? (model.working ? .working : .idle) : .needsYou) : .asleep, look: model.face)
      VStack(alignment: .leading, spacing: 1) {
        if model.kosChoices.count > 1 {
          Menu {
            ForEach(model.kosChoices) { kos in
              Button(kos.name) { model.chooseKOS(kos.id) }
            }
          } label: {
            HStack(spacing: 4) {
              Text(model.kosName.map { "KOS · \($0)" } ?? "KOS")
              Image(systemName: "chevron.up.chevron.down").font(.system(size: 8, weight: .bold)).foregroundStyle(Theme.muted)
            }
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(Theme.text)
          }
          .menuStyle(.button)
          .buttonStyle(.plain)
          .menuIndicator(.hidden)
          .fixedSize()
          .help("Which KOS this window talks to")
        } else {
          Text("KOS").font(.system(size: 15, weight: .semibold))
        }
        Button {
          if !switching { model.list() }
          switching.toggle()
        } label: {
          HStack(spacing: 4) {
            Text(model.online ? model.title : "Not connected").lineLimit(1).truncationMode(.tail)
            if model.online { Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold)) }
          }
          .font(.system(size: ChatType.detail))
          .foregroundStyle(Theme.muted)
        }
        .buttonStyle(.plain)
        .disabled(!model.online)
        .pointingHand(model.online)
        .popover(isPresented: $switching, arrowEdge: .bottom) {
          Switcher(chats: model.chats, current: model.conversation) { id in
            switching = false
            if let id { model.switchTo(id) } else { model.say("/new") }
          }
        }
      }
      Spacer(minLength: 8)
      if model.online { IconButton(symbol: "square.and.pencil", label: "New chat") { model.say("/new") } }
      IconButton(symbol: "xmark", label: "Close", tint: Theme.danger) { model.close() }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
  }

  // MARK: Thread

  private var thread: some View {
    ScrollViewReader { reader in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 10) {
          if model.lines.isEmpty && model.sending.isEmpty {
            Text(model.online ? "Ask about what is in front of you, or have KOS do something on this Mac. It asks before it works here." : "Connect this Mac to KOS to talk to it here.")
              .font(.system(size: ChatType.dense)).foregroundStyle(Theme.muted).padding(.top, 40)
              .frame(maxWidth: .infinity)
              .multilineTextAlignment(.center)
          }
          ForEach(model.items) { item in
            ItemView(item: item)
          }
          if model.working {
            Working(story: model.story)
          }
          Color.clear.frame(height: 1).id("end")
        }
        .padding(.horizontal, 16)
        .padding(.top, 16)
        .padding(.bottom, 8)
        .textSelection(.enabled)
      }
      .onChange(of: model.items.count) { reader.scrollTo("end", anchor: .bottom) }
      .onChange(of: model.story) { reader.scrollTo("end", anchor: .bottom) }
      .onAppear { reader.scrollTo("end", anchor: .bottom) }
    }
  }

  // MARK: Composer

  private var composer: some View {
    VStack(alignment: .leading, spacing: 4) {
      TextField("", text: $model.draft, axis: .vertical)
        .textFieldStyle(.plain)
        .lineLimit(1...6)
        .focused($typing)
        .disabled(!model.online)
        .onSubmit(sendDraft)
        // The hint drawn here, not as the field's own: in the faint grey, on one line, cut at its end, as the dashboard's.
        .overlay(alignment: .topLeading) {
          if model.draft.isEmpty {
            Text("Message KOS, / for commands, @ to name things")
              .foregroundStyle(Theme.faint)
              .lineLimit(1)
              .truncationMode(.tail)
              .allowsHitTesting(false)
          }
        }
      HStack(spacing: 6) {
        if let app = model.beside {
          Chip(symbol: model.besideHidden ? "eye.slash" : "macwindow", text: model.besideHidden ? "Hidden from KOS" : app)
            .help(model.besideHidden ? "The app in front is hidden from KOS" : "What \"this\" means: the app in front")
            // The app's name is what the row is for: it keeps its room longest when the window is narrow.
            .layoutPriority(1)
        }
        if let models = model.models {
          if let fixed = models.fixed {
            Chip(symbol: nil, text: fixed).help("Answering on your Claude Code subscription; change it in KOS, Settings, Models")
          } else {
            Menu {
              ForEach(models.choices, id: \.self) { choice in
                Button(choice) { model.chooseModel(choice) }
              }
            } label: {
              Chip(symbol: nil, text: models.current.isEmpty ? "Model" : models.current)
            }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .menuIndicator(.hidden)
          }
        }
        Button {
          model.setAuto(!model.auto)
        } label: {
          Chip(symbol: model.auto ? "bolt.fill" : "hand.raised", text: model.auto ? "Auto" : "Ask", lit: model.auto)
        }
        .buttonStyle(.plain)
        .fixedSize()
        .help(model.auto ? "KOS works on this Mac without asking each step" : "KOS asks before each step on this Mac")
        Spacer(minLength: 4)
        Button(action: sendDraft) {
          Image(systemName: "arrow.up")
            .font(.system(size: 13, weight: .bold))
            .foregroundStyle(canSend ? Theme.onAccent : Theme.faint)
            .frame(width: 30, height: 30)
            // Nothing to send is grey, as the dashboard's is, not a fainter blue that still reads as a button.
            .background(canSend ? Theme.accent : Theme.line, in: Circle())
        }
        .buttonStyle(.plain)
        .disabled(!canSend)
        .keyboardShortcut(.return, modifiers: .command)
        .accessibilityLabel("Send")
      }
    }
    .padding(EdgeInsets(top: 7, leading: 11, bottom: 7, trailing: 7))
    .background(Theme.panel, in: RoundedRectangle(cornerRadius: Theme.radiusLg, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Theme.radiusLg, style: .continuous).strokeBorder(typing ? Theme.accent.opacity(0.6) : Theme.line))
    .padding(.horizontal, 12)
    .padding(.bottom, 12)
  }

  private var canSend: Bool {
    model.online && !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  private func sendDraft() {
    guard canSend else { return }
    let words = model.draft
    model.draft = ""
    model.say(words)
  }
}

/// One thing in the thread.
private struct ItemView: View {
  let item: ChatModel.Item

  var body: some View {
    switch item {
    case .line(_, let line):
      LineView(line: line)
    case .notice(_, let notice):
      VStack(alignment: .leading, spacing: 3) {
        if let from = notice.from { Text(from).font(.system(size: ChatType.detail, weight: .semibold)).foregroundStyle(Theme.muted) }
        ChatMarkdown(notice.text)
      }
    case .sending(_, let text):
      Bubble(text: text, files: []).opacity(0.6)
    }
  }
}

private struct LineView: View {
  let line: ChatModel.Line

  var body: some View {
    switch line {
    case .you(let text, let files):
      Bubble(text: text, files: files)
    case .kos(let text):
      ChatMarkdown(text).frame(maxWidth: .infinity, alignment: .leading)
    case .note(let text):
      Text(text).font(.system(size: ChatType.detail)).foregroundStyle(Theme.faint).frame(maxWidth: .infinity)
    case .steps(let steps):
      Steps(steps: steps)
    }
  }
}

/// The owner's words: on the right, the accent's tint over panel-2, the corner by the edge tucked in.
private struct Bubble: View {
  let text: String
  let files: [String]

  var body: some View {
    HStack {
      // Up to 88% of the thread's width, as on the dashboard.
      Spacer(minLength: 40)
      VStack(alignment: .leading, spacing: 6) {
        if !text.isEmpty { ChatMarkdown(text) }
        ForEach(files, id: \.self) { file in
          Label(file, systemImage: "doc").font(.system(size: ChatType.detail)).foregroundStyle(Theme.muted)
        }
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 9)
      .background(
        UnevenRoundedRectangle(topLeadingRadius: Theme.radiusLg, bottomLeadingRadius: Theme.radiusLg, bottomTrailingRadius: Theme.radiusXs, topTrailingRadius: Theme.radiusLg, style: .continuous)
          .fill(Theme.accent.opacity(0.18).blended(over: Theme.panel2)))
    }
  }
}

/// A turn's tool calls, folded to one chip that opens to them.
private struct Steps: View {
  let steps: [ChatModel.Step]
  @State private var open = false

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Button {
        withAnimation(Theme.spring) { open.toggle() }
      } label: {
        HStack(spacing: 5) {
          Image(systemName: "list.bullet").font(.system(size: 10, weight: .semibold))
          Text("\(steps.count) step\(steps.count == 1 ? "" : "s")")
          if steps.contains(where: \.failed) { Circle().fill(Theme.danger).frame(width: 5, height: 5) }
          Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold)).rotationEffect(.degrees(open ? 180 : 0))
        }
        .modifier(ChipLook(lit: false))
      }
      .buttonStyle(.plain)
      .pointingHand()
      if open {
        VStack(alignment: .leading, spacing: 3) {
          ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
            Text("› \(step.summary)").font(.system(size: ChatType.dense)).foregroundStyle(step.failed ? Theme.danger : Theme.muted)
          }
        }
        .padding(.leading, 4)
        .transition(.opacity.combined(with: .move(edge: .top)))
      }
    }
  }
}

/// The running turn: its steps so far, or that it is thinking.
private struct Working: View {
  let story: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      if let story, !story.isEmpty {
        ForEach(Array(story.components(separatedBy: "\n").suffix(4).enumerated()), id: \.offset) { _, line in
          Text(line).font(.system(size: ChatType.detail)).foregroundStyle(Theme.muted).lineLimit(1)
        }
      }
      HStack(spacing: 6) {
        ProgressView().controlSize(.mini)
        Text("Working").font(.system(size: ChatType.detail)).foregroundStyle(Theme.faint)
      }
    }
  }
}

/// An approval to decide here: what, why, and the buttons.
private struct AskCard: View {
  let ask: ChatModel.Ask
  let answer: (String, Bool, Bool) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 6) {
        Circle().fill(Theme.warn).frame(width: 6, height: 6)
        Text("Needs your OK").font(.system(size: ChatType.dense, weight: .semibold))
        Text(ask.tool).font(.system(size: ChatType.detail, design: .monospaced)).foregroundStyle(Theme.muted)
      }
      if let why = ask.why ?? ask.reason { Text(why).font(.system(size: ChatType.table)).foregroundStyle(Theme.text) }
      if let args = ask.args {
        Text(args).font(.system(size: ChatType.detail, design: .monospaced)).foregroundStyle(Theme.faint).lineLimit(3)
      }
      HStack(spacing: 6) {
        Button("Approve") { answer(ask.id, true, false) }.buttonStyle(KOSButtonStyle(.primary))
        if let always = ask.always { Button(always) { answer(ask.id, true, true) }.buttonStyle(KOSButtonStyle(.secondary)) }
        Button("Deny") { answer(ask.id, false, false) }.buttonStyle(KOSButtonStyle(.danger))
      }
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Theme.panel, in: RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous).strokeBorder(Theme.warn.opacity(0.35)))
  }
}

/// The window's own chats, newest first, with a new one on top.
private struct Switcher: View {
  let chats: [ChatModel.Pick]
  let current: String?
  let pick: (String?) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Row(title: "New chat", symbol: "square.and.pencil", when: nil, on: false) { pick(nil) }
      if chats.isEmpty {
        Text("Loading your chats").font(.system(size: ChatType.detail)).foregroundStyle(Theme.faint).padding(8)
      }
      ScrollView {
        VStack(alignment: .leading, spacing: 2) {
          ForEach(chats) { chat in
            Row(title: chat.title, symbol: nil, when: when(chat.updated), on: chat.id == current) { pick(chat.id) }
          }
        }
      }
      .frame(maxHeight: 280)
    }
    .padding(6)
    .frame(width: 260)
    .background(Theme.panel)
  }

  private struct Row: View {
    let title: String
    let symbol: String?
    let when: String?
    let on: Bool
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
      Button(action: action) {
        HStack(spacing: 8) {
          if let symbol { Image(systemName: symbol).font(.system(size: 11)) }
          Text(title).lineLimit(1).font(.system(size: ChatType.dense, weight: on ? .semibold : .regular))
          Spacer()
          if let when { Text(when).font(.system(size: 11)).foregroundStyle(Theme.faint) }
        }
        .foregroundStyle(on ? Theme.accent : Theme.text)
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(hovering ? Theme.panel2 : .clear, in: RoundedRectangle(cornerRadius: Theme.radiusSm, style: .continuous))
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .onHover { hovering = $0 }
    }
  }

  private func when(_ at: Date, now: Date = Date()) -> String {
    let m = Int((now.timeIntervalSince(at) / 60).rounded())
    if m < 1 { return "now" }
    if m < 60 { return "\(m)m" }
    if m < 24 * 60 { return "\(Int((Double(m) / 60).rounded()))h" }
    return "\(Int((Double(m) / (24 * 60)).rounded()))d"
  }
}

/// A chip under the box: what it is, at a glance, cut at its end when the window is narrow.
private struct Chip: View {
  let symbol: String?
  let text: String
  var lit = false

  var body: some View {
    HStack(spacing: 4) {
      if let symbol { Image(systemName: symbol).font(.system(size: 10, weight: .semibold)) }
      Text(text).lineLimit(1).truncationMode(.tail)
    }
    .modifier(ChipLook(lit: lit))
  }
}

/// The dashboard's chip: 12, a capsule of panel-2 with no edge, 24 high; the accent's tint when it is on.
private struct ChipLook: ViewModifier {
  let lit: Bool

  func body(content: Content) -> some View {
    content
      .font(.system(size: ChatType.detail))
      .foregroundStyle(lit ? Theme.accent : Theme.muted)
      .padding(.horizontal, 10)
      .frame(minHeight: 24)
      .background(Capsule().fill(lit ? Theme.accent.opacity(0.14).blended(over: Theme.panel) : Theme.panel2))
  }
}

extension Color {
  /// This colour, at its opacity, laid over a solid one: the tint the dashboard mixes with color-mix.
  func blended(over base: Color) -> Color {
    let top = NSColor(self).usingColorSpace(.sRGB) ?? .black
    let under = NSColor(base).usingColorSpace(.sRGB) ?? .black
    let a = top.alphaComponent
    return Color(
      .sRGB,
      red: Double(top.redComponent * a + under.redComponent * (1 - a)),
      green: Double(top.greenComponent * a + under.greenComponent * (1 - a)),
      blue: Double(top.blueComponent * a + under.blueComponent * (1 - a)))
  }
}
