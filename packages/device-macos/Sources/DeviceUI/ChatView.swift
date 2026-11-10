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
  /// Which line of the / or @ menu Return takes.
  @State private var picked = 0
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
      OverlayScroll {
        LazyVStack(alignment: .leading, spacing: 10) {
          if model.lines.isEmpty && model.sending.isEmpty && model.notices.isEmpty {
            EmptyChat(paired: model.paired, silent: model.silent, online: model.online, ask: model.say)
          }
          ForEach(model.items) { item in
            ItemView(item: item, model: model)
          }
          // At the foot for as long as the turn runs: words after the steps are not the end of the work.
          // The owner holding the Mac, it is theirs to hand back or stop, here as on the bar.
          if let foot = model.foot {
            if model.heldByOwner {
              HeldCard(handBack: model.handBack, stop: model.stop)
            } else {
              Working(what: foot, since: model.workingSince ?? Date(), live: model.footLive)
            }
          }
          ForEach(model.asks) { ask in AskCard(ask: ask, answer: model.answer) }
          if let consent = model.consent { ConsentCard(consent: consent) }
          Color.clear.frame(height: 1).id("end")
        }
        .padding(.horizontal, 16)
        .padding(.top, 16)
        .padding(.bottom, 8)
        .textSelection(.enabled)
      }
      .onChange(of: model.items.count) { reader.scrollTo("end", anchor: .bottom) }
      .onChange(of: model.stories) { reader.scrollTo("end", anchor: .bottom) }
      .onChange(of: model.asks.count) { reader.scrollTo("end", anchor: .bottom) }
      .onChange(of: model.consent) { reader.scrollTo("end", anchor: .bottom) }
      .onChange(of: model.heldByOwner) { reader.scrollTo("end", anchor: .bottom) }
      .onAppear { reader.scrollTo("end", anchor: .bottom) }
    }
  }

  // MARK: Composer

  private var composer: some View {
    VStack(alignment: .leading, spacing: 4) {
      if let menu = model.menu { CommandMenu(options: menu.options, picked: picked, take: model.take) }
      if let quote = model.quote {
        QuoteCard(text: quote.text, from: quote.from, label: "Selected text", lines: 2, remove: model.putQuoteAside).padding(.leading, -4).padding(.bottom, 2)
      }
      if let hint = model.hint, model.quote == nil {
        Text(hint).font(.kos(.tiny)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true).padding(.bottom, 2)
      }
      TextField("", text: $model.draft, axis: .vertical)
        .textFieldStyle(.plain)
        .lineLimit(1...6)
        .focused($typing)
        .disabled(!model.usable)
        .onSubmit(sendDraft)
        .onChange(of: model.menu?.token.raw) { picked = 0 }
        .onChange(of: typing) { if typing { model.readSelection() } }
        .onKeyPress(keys: [.upArrow, .downArrow, .tab, .escape]) { press in menuKey(press.key) }
        // The hint drawn here, not as the field's own: in the faint grey, on one line, cut at its end, as the dashboard's.
        .overlay(alignment: .topLeading) {
          if model.draft.isEmpty {
            Text(model.quote == nil ? "Message KOS, / for commands, @ to name things" : "Ask about the selection")
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
        .help(model.auto ? "KOS acts without asking; strict steps still ask" : "KOS asks before each step")
        Spacer(minLength: 4)
        // While this chat has something going, the button stops it; words typed meanwhile still go with Return.
        if model.busy {
          Button(action: model.stop) {
            Image(systemName: "stop.fill").font(.kos(.small, .bold))
          }
          .buttonStyle(KOSButtonStyle(.danger, round: 30))
          .disabled(!model.usable)
          .keyboardShortcut(.return, modifiers: .command)
          .accessibilityLabel("Stop")
          .help("Stop KOS: the turn, and its session on this Mac")
        } else {
          Button(action: sendDraft) {
            Image(systemName: "arrow.right").font(.kos(.dense, .bold))
          }
          .buttonStyle(KOSButtonStyle(.primary, round: 30))
          .disabled(!canSend)
          .keyboardShortcut(.return, modifiers: .command)
          .accessibilityLabel("Send")
        }
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

  /// The arrows move through the menu, Tab takes the line picked, Escape closes it; with no menu, the keys are the box's.
  private func menuKey(_ key: KeyEquivalent) -> KeyPress.Result {
    guard let options = model.menu?.options else { return .ignored }
    switch key {
    case .upArrow: picked = (picked + options.count - 1) % options.count
    case .downArrow: picked = (picked + 1) % options.count
    case .tab: model.take(options[min(picked, options.count - 1)])
    default: model.closeMenu()
    }
    return .handled
  }

  private func sendDraft() {
    // Return with the menu open takes the line picked, as Tab does.
    if let options = model.menu?.options {
      model.take(options[min(picked, options.count - 1)])
      return
    }
    guard canSend else { return }
    let words = model.draft
    model.draft = ""
    model.say(words)
  }
}

/// The / or @ menu over the box: what may go in place of what is typed, the line Return takes lit.
private struct CommandMenu: View {
  let options: [ChatMenus.Option]
  let picked: Int
  let take: (ChatMenus.Option) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 1) {
      ForEach(Array(options.enumerated()), id: \.offset) { i, option in
        MenuRow(on: i == picked, height: 26, action: { take(option) }) { _ in
          HStack(spacing: 8) {
            Text(option.label).font(.kos(.control)).lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 6)
            if let hint = option.hint {
              Text(hint).font(.kos(.tiny)).foregroundStyle(Theme.faint).lineLimit(1).truncationMode(.tail)
            }
          }
        }
      }
    }
    .padding(.bottom, 4)
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
    // The side panel's .empty-state sits in the middle of the thread (margin: auto): the thread's height, less its 16 and 8 of padding.
    .containerRelativeFrame(.vertical, alignment: .center) { height, _ in max(0, height - 24) }
  }

  /// The kit's .hint: muted at 13, as the dashboard and the side panel draw theirs.
  private func hint(_ words: String) -> some View {
    Text(words).font(.kos(.dense)).foregroundStyle(Theme.muted).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
  }
}

/// One thing in the thread.
private struct ItemView: View {
  let item: ChatModel.Item
  @ObservedObject var model: ChatModel

  var body: some View {
    switch item {
    case .line(_, let line):
      LineView(line: line, model: model)
    case .notice(_, let notice):
      VStack(alignment: .leading, spacing: 2) {
        // Who answered, when it was not KOS itself, in the violet a passed-on sender is named in.
        if let from = notice.from { Text(from).font(.kos(.tiny, .semibold)).foregroundStyle(Theme.violet) }
        ChatMarkdown(notice.text)
      }
    case .sending(_, let text):
      Bubble(text: text, files: []).opacity(0.6)
    case .story(_, let story):
      // A turn on the go: its steps so far, live, and what KOS is saying after them.
      let told = ChatModel.read(story.text)
      if !told.steps.isEmpty { Steps(steps: told.steps, live: true, pictures: model.picturesOf(model.liveFrames(of: story.said))) }
      if !told.words.isEmpty { ChatMarkdown(told.words).foregroundStyle(Theme.muted) }
    }
  }
}

private struct LineView: View {
  let line: ChatModel.Line
  @ObservedObject var model: ChatModel

  var body: some View {
    switch line {
    case .you(let text, let files, let quote):
      Bubble(text: text, files: files, quote: quote)
    case .kos(let text):
      ChatMarkdown(text).frame(maxWidth: .infinity, alignment: .leading)
    case .note(let text):
      Text(text).font(.kos(.tiny)).foregroundStyle(Theme.faint).multilineTextAlignment(.center).frame(maxWidth: .infinity)
    case .steps(let steps):
      Steps(steps: steps, pictures: model.picturesOf(steps.map(\.frame)))
    }
  }
}

/// The owner's words: on the right, the accent's tint over panel-2, the corner by the edge tucked in.
/// In light, the dashboard's lighter tint over the white panel, which panel-2's grey made dull.
private struct Bubble: View {
  private static let fill = Color(
    dark: Theme.Dark.accent.opacity(0.18).blended(over: Theme.Dark.panel2),
    light: Theme.Light.accent.opacity(0.09).blended(over: Theme.Light.panel))
  let text: String
  let files: [String]
  var quote: ChatModel.Quote? = nil

  var body: some View {
    HStack {
      // Up to 88% of the thread's width, as on the dashboard.
      Spacer(minLength: 40)
      VStack(alignment: .leading, spacing: 6) {
        if let quote { QuoteCard(text: quote.text, from: quote.from) }
        if !text.isEmpty { ChatMarkdown(text) }
        ForEach(files, id: \.self) { file in
          Label(file, systemImage: "doc").font(.kos(.detail)).foregroundStyle(Theme.muted)
        }
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 9)
      .background(
        UnevenRoundedRectangle(topLeadingRadius: Theme.radiusLg, bottomLeadingRadius: Theme.radiusLg, bottomTrailingRadius: Theme.radiusXs, topTrailingRadius: Theme.radiusLg, style: .continuous)
          .fill(Self.fill))
    }
  }
}

/// A turn's tool calls, folded to one chip that opens to them; live, the step it is on, in the accent.
/// Under it, what the steps saw, as the dashboard and the side panel show it.
private struct Steps: View {
  let steps: [ChatModel.Step]
  var live = false
  var pictures: [(id: Int, data: Data)] = []
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
      if !pictures.isEmpty {
        FlowPictures(pictures: pictures)
      }
    }
  }
}

/// The steps' pictures in rows that wrap, the newest last; the one pressed opens full width under them.
private struct FlowPictures: View {
  let pictures: [(id: Int, data: Data)]
  @State private var open: Int?

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      LazyVGrid(columns: [GridItem(.adaptive(minimum: StepPicture.small, maximum: StepPicture.small), spacing: 6, alignment: .leading)], alignment: .leading, spacing: 6) {
        ForEach(pictures, id: \.id) { picture in
          StepPicture(picture.data) { withAnimation(Theme.spring) { open = open == picture.id ? nil : picture.id } }
        }
      }
      if let open, let picture = pictures.first(where: { $0.id == open }) {
        StepPicture(picture.data, open: true) { withAnimation(Theme.spring) { self.open = nil } }
          .transition(.opacity)
      }
    }
  }
}

/// The dashboard's live head, at the foot of a running turn: three dots of the accent pulsing in turn, what it is at, and for how long.
/// Not live, held on the owner, it is the words alone: no dots, no clock counting the owner's time.
private struct Working: View {
  let what: String
  let since: Date
  let live: Bool

  var body: some View {
    HStack(spacing: 8) {
      if live { dots }
      Text(what).font(.kos(.detail)).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.tail)
      if live { elapsed }
    }
    .padding(.vertical, 4)
  }

  private var dots: some View {
    TimelineView(.animation) { context in
      let now = context.date.timeIntervalSinceReferenceDate
      HStack(spacing: 3) {
        ForEach(0..<3, id: \.self) { i in
          Dot(Theme.accent, size: 4).opacity(Self.pulse(at: now - Double(i) * 0.15))
        }
      }
    }
  }

  private var elapsed: some View {
    TimelineView(.periodic(from: since, by: 1)) { context in
      Text(elapsedWords(context.date.timeIntervalSince(since)))
        .font(.kos(.detail).monospacedDigit())
        .foregroundStyle(Theme.faint)
    }
  }

  /// The dashboard's live-pulse: a quarter lit, up to full at 30% of each 1.1 s, and back by 60%.
  static func pulse(at time: Double) -> Double {
    let period = 1.1
    let at = (time.truncatingRemainder(dividingBy: period) + period).truncatingRemainder(dividingBy: period) / period
    let rise = at < 0.3 ? at / 0.3 : at < 0.6 ? 1 - (at - 0.3) / 0.3 : 0
    return 0.25 + 0.75 * rise
  }
}

/// The owner took the Mac over from this chat's turn: KOS waits for it back, or for Stop.
private struct HeldCard: View {
  let handBack: () -> Void
  let stop: () -> Void

  var body: some View {
    Card(tone: Theme.warn, padding: EdgeInsets(top: 12, leading: 14, bottom: 12, trailing: 14)) {
      RowText("Paused, you have control", "KOS waits until you hand it back.", size: .control)
      HStack(spacing: 6) {
        Button("Hand back", action: handBack).buttonStyle(KOSButtonStyle(.primary))
        Button("Stop", action: stop).buttonStyle(KOSButtonStyle(.danger))
      }
    }
  }
}

/// A session this chat asked for, asked on the owner's screen: answered there, and said here so the chat does not look stuck.
private struct ConsentCard: View {
  let consent: ChatModel.Consent

  var body: some View {
    Card(tone: Theme.warn, padding: EdgeInsets(top: 12, leading: 14, bottom: 12, trailing: 14)) {
      SectionLabel("KOS asks to use this Mac")
      Text(consent.task).font(.kos(.dense)).fixedSize(horizontal: false, vertical: true)
      TimelineView(.periodic(from: .now, by: 1)) { context in
        Text("Asking on your screen… Allow there · \(secondsLeft(until: consent.until, now: context.date))")
          .font(.kos(.detail).monospacedDigit())
          .foregroundStyle(Theme.muted)
      }
    }
  }
}

/// What is left before an ask answers itself, as the prompt counts it.
func secondsLeft(until: Date, now: Date) -> String {
  let left = max(0, Int(until.timeIntervalSince(now).rounded(.up)))
  return left < 60 ? "\(left)s" : "\(left / 60)m \(String(format: "%02d", left % 60))s"
}

/// An approval to decide in the thread, as the panel's card asks it: what KOS would run, why, with what, and the dashboard's buttons.
private struct AskCard: View {
  let ask: ChatModel.Ask
  let answer: (String, Bool, Bool) -> Void

  var body: some View {
    Card(tone: Theme.warn, padding: EdgeInsets(top: 12, leading: 14, bottom: 12, trailing: 14)) {
      SectionLabel("KOS asks to run")
      Text(ask.tool).font(.kos(.dense, .semibold, design: .monospaced))
      // The actions the yes is for, whole: the arguments under them are cut at eight lines.
      if let mechanics = ask.mechanics {
        Text(mechanics).font(.kos(.detail)).fixedSize(horizontal: false, vertical: true)
      }
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
        if let expires = ask.expires {
          Spacer(minLength: 4)
          TimelineView(.periodic(from: .now, by: 1)) { context in
            Text("Times out in \(secondsLeft(until: expires, now: context.date))")
              .font(.kos(.detail).monospacedDigit())
              .foregroundStyle(Theme.faint)
          }
        }
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
      OverlayScroll {
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

