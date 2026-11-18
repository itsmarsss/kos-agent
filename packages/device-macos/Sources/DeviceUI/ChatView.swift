import SwiftUI
import AppKit

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
  /// How tall the thread shows, so the empty chat can take that height and sit in its middle.
  @State private var threadHeight: CGFloat = 0
  @FocusState private var typing: Bool

  public static let size = CGSize(width: 380, height: 560)
  /// The room over the thread's first line, and the gap between its items.
  static let threadTop: CGFloat = 16
  static let threadGap: CGFloat = 10

  private var hasCard: Bool { model.paired && model.beside != nil }
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
          // The thread's own gap under it, so a line scrolled up to the card never sits flush against it.
          .padding(.bottom, Self.threadGap)
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
    guard model.online else { return BlobMood(link: model.link) }
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
        VStack(alignment: .leading, spacing: 10) {
          if model.lines.isEmpty && model.sending.isEmpty && model.notices.isEmpty {
            EmptyChat(paired: model.paired, silent: model.silent, online: model.online, ask: model.say)
              // The side panel's .empty-state sits in the middle of the thread (margin: auto), and the thread does not scroll.
              .frame(minHeight: max(0, threadHeight - EmptyChat.threadChrome + (hasCard ? Self.threadGap : 0)))
          }
          // Each item from its own values: a step told elsewhere in the turn never redraws the rest of the thread.
          ForEach(model.items) { item in
            ItemView(item: item, pictures: model.pictures(for: item)).equatable()
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
        // Under the app card the card's gap is the thread's; with none, the thread's own top.
        .padding(.top, hasCard ? Self.threadTop - Self.threadGap : Self.threadTop)
        .padding(.bottom, 8)
        .textSelection(.enabled)
      }
      // A line scrolled up under the card fades out rather than ending in a cut; within the thread's top padding,
      // so the first line at rest is never faded.
      .mask {
        VStack(spacing: 0) {
          LinearGradient(colors: [.clear, .black], startPoint: .top, endPoint: .bottom).frame(height: hasCard ? Self.threadTop - Self.threadGap : 0)
          Color.black
        }
      }
      // Measured here, not by containerRelativeFrame, which macOS 15 resolves against the window, not the scroll view.
      .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { threadHeight = $0 }
      .defaultScrollAnchor(.bottom)
      // Once what came in has settled, not on each piece of it: a turn telling its steps a few at a time scrolls once.
      .task(id: scrollKey) {
        try? await Task.sleep(for: Self.scrollPause)
        guard !Task.isCancelled else { return }
        reader.scrollTo("end", anchor: .bottom)
      }
    }
  }

  /// How long the thread waits for what came in to settle before it scrolls to the end.
  static let scrollPause: Duration = .milliseconds(80)

  /// What moves the thread's end: the items, the running stories, the asks, a session's ask, and the owner taking over.
  private var scrollKey: [AnyHashable] {
    [model.items.count, model.stories.map(\.text), model.asks.count, model.consent?.task, model.heldByOwner, model.liveFrames]
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
  }

  /// What the thread holds around the empty state: its padding, 16 above and 8 below, and the end marker with its gap.
  static let threadChrome: CGFloat = 16 + 8 + 1 + 10

  /// The kit's .hint: muted at 13, as the dashboard and the side panel draw theirs.
  private func hint(_ words: String) -> some View {
    Text(words).font(.kos(.dense)).foregroundStyle(Theme.muted).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
  }
}

/// One thing in the thread, drawn from its own values alone, so it is redrawn only when they change.
private struct ItemView: View, Equatable {
  let item: ChatModel.Item
  let pictures: [ChatModel.Picture]

  var body: some View {
    switch item {
    case .line(_, let line, let time):
      ChatLine(line, time: time, pictures: pictures)
    case .mark(_, let mark):
      TimeMarkLine(mark)
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
      if !told.steps.isEmpty { Steps(steps: told.steps, live: true, pictures: pictures) }
      if !told.words.isEmpty { ChatMarkdown(told.words).foregroundStyle(Theme.muted) }
    }
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

/// An approval to decide in the thread, as the dashboard's card asks it (`AskSummary`): who asks and how long it
/// has, what KOS wants to do and where, each step with its keys as keycaps, why, the arguments under Details, then
/// Deny, the remembered yes and Approve at one height. Focused, Return approves and Escape or ⌘⌫ denies.
struct AskCard: View {
  let ask: ChatModel.Ask
  let answer: (String, Bool, Bool) -> Void
  @FocusState private var focused: Bool
  /// The focus came by the Tab key, not a click or the window's own first focus: only then does Return approve.
  @State private var byTab = false
  /// A decision has gone: a second press or a held key sends nothing more.
  @State private var decided = false

  var body: some View {
    Card(tone: Theme.warn, padding: EdgeInsets(top: 12, leading: 14, bottom: 12, trailing: 14)) {
      HStack(alignment: .firstTextBaseline) {
        SectionLabel(ask.asker.map { "\($0) asks" } ?? "KOS asks")
        Spacer(minLength: 6)
        if let expires = ask.expires {
          TimelineView(.periodic(from: .now, by: 1)) { context in
            Text("lapses in \(secondsLeft(until: expires, now: context.date))")
              .font(.kos(.detail).monospacedDigit())
              .foregroundStyle(expires.timeIntervalSince(context.date) <= 15 ? Theme.warn : Theme.faint)
          }
        }
      }
      AskSummary(ask)
      if let args = ask.args { AskDetails(tool: ask.tool, args: args) }
      if ask.tooLong {
        Text("Too long to show here in full. Open it in the dashboard's Inbox to approve it.").font(.kos(.detail)).foregroundStyle(Theme.muted)
          .fixedSize(horizontal: false, vertical: true)
      } else if ask.always == nil, let note = ask.alwaysNote {
        Text(note).font(.kos(.detail)).foregroundStyle(Theme.faint)
      }
      // One row at the foot when it fits; else one to a row, full width, Approve first.
      ViewThatFits(in: .horizontal) {
        HStack(spacing: 6) {
          Spacer(minLength: 0)
          deny(wide: false)
          always(wide: false)
          approve(wide: false)
        }
        VStack(spacing: 6) {
          approve(wide: true)
          always(wide: true)
          deny(wide: true)
        }
      }
      .padding(.top, 2)
    }
    .focusable()
    .focused($focused)
    .focusEffectDisabled()
    .overlay(RoundedRectangle(cornerRadius: Theme.radiusMd + 2, style: .continuous).strokeBorder(Theme.accent, lineWidth: 2).padding(-3).opacity(focused ? 1 : 0))
    .onChange(of: focused) { _, now in byTab = now && AskKeys.cameByTab(NSApp.currentEvent) }
    // Down only: a held key's repeats are other phases, and are not heard.
    .onKeyPress(keys: [.return, .escape, .delete], phases: .down) { press in
      guard let approved = AskKeys.decision(press.key, command: press.modifiers.contains(.command), focused: focused, byTab: byTab, canApprove: !ask.tooLong) else {
        return .ignored
      }
      decide(approved: approved, remember: false)
      return .handled
    }
  }

  private func decide(approved: Bool, remember: Bool) {
    guard !decided else { return }
    decided = true
    answer(ask.id, approved, remember)
  }

  @ViewBuilder private func approve(wide: Bool) -> some View {
    if !ask.tooLong {
      Button { decide(approved: true, remember: false) } label: { Text("Approve").frame(maxWidth: wide ? .infinity : nil) }
        .buttonStyle(KOSButtonStyle(.primary))
        .help("Approve (Return, once Tab has moved to the card)")
    }
  }

  @ViewBuilder private func always(wide: Bool) -> some View {
    if let always = ask.always, !ask.tooLong {
      Button { decide(approved: true, remember: true) } label: { Text(always).frame(maxWidth: wide ? .infinity : nil) }
        .buttonStyle(KOSButtonStyle(.secondary))
        .help(ask.alwaysTip ?? "Approves this, and stops asking for the same again. Undo it in Settings, Permissions.")
    }
  }

  private func deny(wide: Bool) -> some View {
    Button { decide(approved: false, remember: false) } label: { Text("Deny").frame(maxWidth: wide ? .infinity : nil) }
      .buttonStyle(KOSButtonStyle(.secondary))
      .help("Deny (Esc)")
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
        // Room for the thumb at the right, so a row's right end still takes the press.
        .padding(.trailing, 6)
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

/// The approval card's keys, apart from the view so they can be tested: Return approves only with the card
/// focused by Tab (a click or the window's own first focus is no yes), Escape and ⌘⌫ deny with the card focused.
enum AskKeys {
  /// The Tab key's virtual key code.
  static let tab: UInt16 = 48

  /// A focus that came with this event came by the Tab key.
  static func cameByTab(_ event: NSEvent?) -> Bool {
    guard let event, event.type == .keyDown else { return false }
    return event.keyCode == tab
  }

  /// What a key on the card decides: true to approve, false to deny, nil for nothing.
  static func decision(_ key: KeyEquivalent, command: Bool, focused: Bool, byTab: Bool, canApprove: Bool) -> Bool? {
    guard focused else { return nil }
    switch key {
    case .return: return byTab && canApprove ? true : nil
    case .escape: return false
    case .delete: return command ? false : nil
    default: return nil
    }
  }
}
