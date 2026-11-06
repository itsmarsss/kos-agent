import SwiftUI

/// KOS for Mac's chat window: the side panel's chat, floating over the
/// owner's apps (docs/design.md, Chat), drawn from the kit (Controls.swift)
/// as the panel is drawn from the extension's. KOS's face and the chat's
/// name lead it, the name opening the window's own chats; the app in front
/// on its card, as the panel's tab; the thread, ending in what waits on the
/// owner; then the box, with the model and Ask or Auto under it.
public struct ChatView: View {
  @ObservedObject private var model: ChatModel
  @State private var switching = false
  @FocusState private var typing: Bool

  public static let size = CGSize(width: 380, height: 560)
  /// The smallest the window may be: the box and a few lines above it.
  public static let smallest = CGSize(width: 320, height: 380)

  public init(model: ChatModel) {
    self.model = model
  }

  public var body: some View {
    VStack(spacing: 0) {
      header
      Hairline()
      if model.paired, let app = model.beside {
        AppCard(name: app, title: model.besideTitle, hidden: model.besideHidden, session: model.session)
          .padding(.horizontal, 12)
          .padding(.top, 10)
      }
      thread
      if let error = model.error {
        Text(error).font(.kos(.detail)).foregroundStyle(Theme.danger)
          .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.bottom, 6)
      }
      if model.paired && !model.silent { composer }
    }
    .frame(minWidth: Self.smallest.width, minHeight: Self.smallest.height)
    // Up to the window's top edge: its title bar is hidden, and the header is where it is dragged from.
    .ignoresSafeArea(.container, edges: .top)
    .background(Theme.bg)
    .foregroundStyle(Theme.text)
    .font(.kos(.body))
    .onAppear { typing = true }
  }

  // MARK: Header

  private var mood: BlobMood {
    guard model.online else { return .asleep }
    return model.asks.isEmpty ? (model.working ? .working : .idle) : .needsYou
  }

  private var header: some View {
    HStack(spacing: 10) {
      KOSFace(size: 30, mood: mood, look: model.face)
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
            .font(.kos(.body, .semibold))
            .foregroundStyle(Theme.text)
          }
          .menuStyle(.button)
          .buttonStyle(.plain)
          .menuIndicator(.hidden)
          .fixedSize()
          .help("Which KOS this window talks to")
        } else {
          Text("KOS").font(.kos(.body, .semibold))
        }
        if model.usable {
          ChatTitle(text: model.subtitle, open: switching) {
            if !switching { model.list() }
            switching.toggle()
          }
          .popover(isPresented: $switching, arrowEdge: .bottom) {
            Switcher(chats: model.chats, current: model.conversation) { id in
              switching = false
              if let id { model.switchTo(id) } else { model.say("/new") }
            }
            .onExitCommand { switching = false }
          }
        } else {
          Text(model.subtitle).font(.kos(.detail)).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.tail)
        }
      }
      Spacer(minLength: 8)
      if model.usable { IconButton(symbol: "square.and.pencil", label: "New chat") { model.say("/new") } }
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
          if model.lines.isEmpty && model.sending.isEmpty && model.notices.isEmpty {
            EmptyChat(paired: model.paired, silent: model.silent, online: model.online, ask: model.say)
          }
          ForEach(model.items) { item in
            ItemView(item: item)
          }
          if model.working {
            let running = model.running
            if !running.steps.isEmpty { Steps(steps: running.steps, live: true) }
            if !running.words.isEmpty { ChatMarkdown(running.words).foregroundStyle(Theme.muted) }
          }
          // At the foot for as long as the turn runs: words after the steps are not the end of the work.
          if let foot = model.foot { Working(what: foot, since: model.workingSince ?? Date()) }
          ForEach(model.asks) { ask in AskCard(ask: ask, answer: model.answer) }
          Color.clear.frame(height: 1).id("end")
        }
        .padding(.horizontal, 16)
        .padding(.top, 16)
        .padding(.bottom, 8)
        .textSelection(.enabled)
      }
      .onChange(of: model.items.count) { reader.scrollTo("end", anchor: .bottom) }
      .onChange(of: model.story) { reader.scrollTo("end", anchor: .bottom) }
      .onChange(of: model.asks.count) { reader.scrollTo("end", anchor: .bottom) }
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
        .disabled(!model.usable)
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
        if let models = model.models {
          if let fixed = models.fixed {
            Chip(fixed, pressable: false).help("Answering on your Claude Code subscription; change it in KOS, Settings, Models")
          } else {
            Menu {
              ForEach(models.choices, id: \.self) { choice in
                Button(choice) { model.chooseModel(choice) }
              }
            } label: {
              Chip(models.current.isEmpty ? "Model" : models.current, opens: false)
            }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .menuIndicator(.hidden)
          }
        }
        Button {
          model.setAuto(!model.auto)
        } label: {
          Chip(model.auto ? "Auto" : "Ask", symbol: model.auto ? "bolt" : "hand.raised", lit: model.auto)
        }
        .buttonStyle(.plain)
        .fixedSize()
        .help(model.auto ? "KOS works on this Mac without asking each step" : "KOS asks before each step on this Mac")
        Spacer(minLength: 4)
        Button(action: sendDraft) {
          Image(systemName: "arrow.right").font(.kos(.dense, .bold))
        }
        .buttonStyle(KOSButtonStyle(.primary, round: 30))
        .disabled(!canSend)
        .keyboardShortcut(.return, modifiers: .command)
        .accessibilityLabel("Send")
      }
    }
    .padding(EdgeInsets(top: 7, leading: 11, bottom: 7, trailing: 7))
    .background(Theme.panel, in: RoundedRectangle(cornerRadius: Theme.radiusLg, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Theme.radiusLg, style: .continuous).strokeBorder(typing ? Theme.accent.opacity(0.6) : Theme.line))
    .opacity(model.usable ? 1 : 0.6)
    .padding(.horizontal, 12)
    .padding(.bottom, 12)
  }

  private var canSend: Bool {
    model.usable && !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  private func sendDraft() {
    guard canSend else { return }
    let words = model.draft
    model.draft = ""
    model.say(words)
  }
}

/// The chat's name under KOS, opening its chats: lighter under the pointer, its chevron turned while they are open, as the panel's is.
private struct ChatTitle: View {
  let text: String
  let open: Bool
  let action: () -> Void
  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      HStack(spacing: 4) {
        Text(text).lineLimit(1).truncationMode(.tail)
        Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold)).rotationEffect(.degrees(open ? 180 : 0))
      }
      .font(.kos(.detail))
      .foregroundStyle(hovering || open ? Theme.text : Theme.muted)
      .padding(.horizontal, 4)
      .padding(.vertical, 1)
      .background(hovering || open ? Theme.panel2 : .clear, in: RoundedRectangle(cornerRadius: Theme.radiusXs, style: .continuous))
      .padding(.horizontal, -4)
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
    .pointingHand()
    .animation(Theme.hover, value: hovering)
    .animation(Theme.spring, value: open)
    .help("Switch chat")
  }
}

/// The app in front, which "this" means: what it is, its window, and what KOS may do in it, as the panel's tab card says of the tab.
private struct AppCard: View {
  let name: String
  let title: String?
  let hidden: Bool
  let session: ChatModel.Session?

  var body: some View {
    let live = session != nil && !hidden
    Card(tone: live ? Theme.accent : nil, padding: EdgeInsets(top: 10, leading: 12, bottom: 10, trailing: 12)) {
      HStack(spacing: 12) {
        Tile(hidden ? "eye.slash" : "macwindow", tint: Theme.accent, small: true)
        // A hidden app's window is named nowhere, here included.
        RowText(name, hidden ? "KOS never sees this app" : title ?? "The app in front", size: .control, titleLines: 1, detailLines: 1)
        Spacer(minLength: 6)
        pill
      }
    }
    .animation(Theme.hover, value: live)
  }

  private var pill: Pill {
    if hidden { return Pill("Hidden from KOS", tone: .muted) }
    switch session {
    case .working: return Pill("KOS is working", tone: .accent)
    case .paused: return Pill("You have it", tone: .warn)
    case nil: return Pill("Asks first", tone: .muted)
    }
  }
}

/// Nothing said yet: what this window is for, and a few things to ask; or why it cannot be talked to.
private struct EmptyChat: View {
  let paired: Bool
  let silent: Bool
  let online: Bool
  let ask: (String) -> Void

  static let suggestions = ["What am I looking at?", "Summarize this window", "What can you do here?"]

  var body: some View {
    VStack(spacing: 10) {
      if !paired {
        KOSFace(size: 64, mood: .asleep)
        Text("Pair this Mac with KOS").font(.kos(.dense, .semibold))
        hint("Open KOS for Mac from the menu bar and paste a pairing link from KOS: Settings, Devices, Add a device.")
      } else if silent {
        KOSFace(size: 56, mood: .error)
        Text("This KOS cannot talk here yet").font(.kos(.dense, .semibold))
        hint("It is connected, but it does not answer this window. Update KOS, restart it, then open this window again. Its other work on this Mac is not affected.")
      } else {
        hint("Ask about the app in front, or have KOS do something in it. It asks before it works here.")
        if online {
          VStack(spacing: 6) {
            ForEach(Self.suggestions, id: \.self) { words in
              Button(words) { ask(words) }.buttonStyle(KOSButtonStyle(.secondary, small: true))
            }
          }
        }
      }
    }
    .frame(maxWidth: 300)
    .padding(24)
    .frame(maxWidth: .infinity)
    .padding(.top, 16)
  }

  /// The kit's .hint: muted at 13, as the dashboard and the side panel draw theirs.
  private func hint(_ words: String) -> some View {
    Text(words).font(.kos(.dense)).foregroundStyle(Theme.muted).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
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
      VStack(alignment: .leading, spacing: 2) {
        // Who answered, when it was not KOS itself, in the violet a passed-on sender is named in.
        if let from = notice.from { Text(from).font(.kos(.tiny, .semibold)).foregroundStyle(Theme.violet) }
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
      Text(text).font(.kos(.tiny)).foregroundStyle(Theme.faint).multilineTextAlignment(.center).frame(maxWidth: .infinity)
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
          Label(file, systemImage: "doc").font(.kos(.detail)).foregroundStyle(Theme.muted)
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

/// A turn's tool calls, folded to one chip that opens to them; live, the step it is on, in the accent.
private struct Steps: View {
  let steps: [ChatModel.Step]
  var live = false
  @State private var open = false

  private var label: String {
    let failed = steps.filter(\.failed).count
    let said = live
      ? "\(steps.count > 1 ? "\(steps.count). " : "")\(steps.last?.summary ?? "Working")"
      : "\(steps.count) step\(steps.count == 1 ? "" : "s")"
    return failed > 0 ? "\(said) · \(failed) failed" : said
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Button {
        guard !live else { return }
        withAnimation(Theme.spring) { open.toggle() }
      } label: {
        Chip(label, symbol: "checklist", lit: live, pressable: !live, opens: live ? nil : open)
      }
      .buttonStyle(.plain)
      if open && !live {
        VStack(alignment: .leading, spacing: 3) {
          ForEach(Array(steps.enumerated()), id: \.offset) { i, step in
            HStack(alignment: .firstTextBaseline, spacing: 6) {
              Text(verbatim: "\(i + 1).").monospacedDigit().frame(minWidth: 14, alignment: .trailing)
              Text(step.summary)
            }
            .font(.kos(.dense))
            .foregroundStyle(step.failed ? Theme.danger : Theme.muted)
          }
        }
        .padding(.leading, 6)
        .transition(.opacity.combined(with: .move(edge: .top)))
      }
    }
  }
}

/// The dashboard's live head, at the foot of a running turn: three dots of the accent pulsing in turn, what it is at, and for how long.
private struct Working: View {
  let what: String
  let since: Date

  var body: some View {
    HStack(spacing: 8) {
      TimelineView(.animation) { context in
        let now = context.date.timeIntervalSinceReferenceDate
        HStack(spacing: 3) {
          ForEach(0..<3, id: \.self) { i in
            Dot(Theme.accent, size: 4).opacity(Self.pulse(at: now - Double(i) * 0.15))
          }
        }
      }
      Text(what).font(.kos(.detail)).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.tail)
      TimelineView(.periodic(from: since, by: 1)) { context in
        Text(elapsedWords(context.date.timeIntervalSince(since)))
          .font(.kos(.detail).monospacedDigit())
          .foregroundStyle(Theme.faint)
      }
    }
    .padding(.vertical, 4)
  }

  /// The dashboard's live-pulse: a quarter lit, up to full at 30% of each 1.1 s, and back by 60%.
  static func pulse(at time: Double) -> Double {
    let period = 1.1
    let at = (time.truncatingRemainder(dividingBy: period) + period).truncatingRemainder(dividingBy: period) / period
    let rise = at < 0.3 ? at / 0.3 : at < 0.6 ? 1 - (at - 0.3) / 0.3 : 0
    return 0.25 + 0.75 * rise
  }
}

/// An approval to decide in the thread, as the panel's card asks it: what KOS would run, why, with what, and the dashboard's buttons.
private struct AskCard: View {
  let ask: ChatModel.Ask
  let answer: (String, Bool, Bool) -> Void

  var body: some View {
    Card(tone: Theme.warn, padding: EdgeInsets(top: 12, leading: 14, bottom: 12, trailing: 14)) {
      SectionLabel("KOS asks to run")
      Text(ask.tool).font(.kos(.dense, .semibold, design: .monospaced))
      if let why = ask.why ?? ask.reason {
        Text(why).font(.kos(.detail)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
      }
      if let args = ask.args {
        Text(args)
          .font(.kos(.small, design: .monospaced))
          .foregroundStyle(Theme.muted)
          .lineLimit(8)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(8)
          .background(Theme.bg, in: RoundedRectangle(cornerRadius: Theme.radiusSm, style: .continuous))
      }
      HStack(spacing: 6) {
        Button("Approve") { answer(ask.id, true, false) }.buttonStyle(KOSButtonStyle(.primary))
        if let always = ask.always { Button(always) { answer(ask.id, true, true) }.buttonStyle(KOSButtonStyle(.secondary)).help("Approve, and stop asking for this") }
        Button("Deny") { answer(ask.id, false, false) }.buttonStyle(KOSButtonStyle(.danger))
      }
    }
  }
}

/// The window's own chats, newest first, with a new one on top; past eight, a field narrows them.
private struct Switcher: View {
  let chats: [ChatModel.Pick]
  let current: String?
  let pick: (String?) -> Void
  @State private var query = ""

  private var shown: [ChatModel.Pick] {
    let q = query.trimmingCharacters(in: .whitespaces).lowercased()
    return q.isEmpty ? chats : chats.filter { $0.title.lowercased().contains(q) }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      MenuRow(action: { pick(nil) }) { _ in
        Label("New chat", systemImage: "square.and.pencil").font(.kos(.control, .semibold)).foregroundStyle(Theme.accent)
      }
      Hairline()
      if chats.count > 8 { KOSField(nil, placeholder: "Find a chat", text: $query) }
      if chats.isEmpty {
        Text("Loading your chats").font(.kos(.detail)).foregroundStyle(Theme.faint).padding(8)
      }
      ScrollView {
        VStack(alignment: .leading, spacing: 1) {
          ForEach(shown) { chat in
            MenuRow(on: chat.id == current, action: { pick(chat.id) }) { _ in
              HStack(spacing: 8) {
                Text(chat.title).font(.kos(.control)).lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 6)
                Text(when(chat.updated)).font(.kos(.tiny)).monospacedDigit().foregroundStyle(Theme.faint)
              }
            }
          }
        }
      }
      .frame(maxHeight: 280)
    }
    .padding(4)
    .frame(width: 260)
    .background(Theme.panel)
  }

  private func when(_ at: Date, now: Date = Date()) -> String {
    let m = Int((now.timeIntervalSince(at) / 60).rounded())
    if m < 1 { return "now" }
    if m < 60 { return "\(m)m" }
    if m < 24 * 60 { return "\(Int((Double(m) / 60).rounded()))h" }
    return "\(Int((Double(m) / (24 * 60)).rounded()))d"
  }
}

