import AppKit
import DeviceCore
import DeviceUI

/// KOS for Mac's chat window and the KOS it talks to: the chat that KOS's
/// calls show, drawn; the owner's words and decisions, sent on; and the app
/// in front, told with each message as where they spoke.
///
/// It talks to one KOS at a time, the one the window speaks of (the one at
/// work, else the first connected, else the first paired), and a call from
/// any other is answered and left undrawn.
@MainActor
final class ChatController {
  let model = ChatModel()
  /// A frame to a KOS, by this Mac's device id there.
  var send: ((String, Data) -> Void)?
  /// The KOS the window talks to: its id, what to call it when there are several, and whether its line is up.
  var target: () -> (id: String, name: String?, online: Bool)? = { nil }
  var faceOf: (String) -> FaceLook = { _ in .kos }
  var isHidden: (String?) -> Bool = { _ in false }
  /// The session on this Mac, and the ask for one, by the KOS and the chat they are for: the window shows its own chat's alone.
  var session: (origin: String, conversation: String?, paused: Bool)? { didSet { scope() } }
  var asking: (origin: String, conversation: String?, task: String, until: Date)? { didSet { scope() } }

  private lazy var window: ChatWindow = {
    let window = ChatWindow(model: model)
    window.onKey = { [weak self] in self?.readSelection() }
    return window
  }()
  /// Whether the window was ever made: stepping aside does not make one.
  private var made = false
  private var talkingTo: String?
  private var wasOnline = false
  private var taking: Timer?
  /// Set while the window waits for a KOS that is on to show the chat.
  private var showing: Timer?
  /// The app the owner was in, watched from launch so it is known when the window first opens over KOS for Mac's own.
  private var front = FrontTracker<NSRunningApplication> { $0.processIdentifier == ProcessInfo.processInfo.processIdentifier }
  private var frontWatch: NSObjectProtocol?
  private let selection = SelectionReader(Accessibility())
  private var reading: Task<Void, Never>?
  private var readAgain = false
  /// The owner was told once that without Accessibility the window cannot bring in what they select.
  private var toldAccess = false

  /// How long the window waits to hear that KOS has the owner's words before it gives them back.
  private static let takeWithin: TimeInterval = 12
  /// How long a KOS that is on has to show the chat, as the side panel waits, before the window says it cannot talk here.
  private static let showWithin: TimeInterval = 6

  init() {
    model.send = { [weak self] text, quote in self?.say(text, quote: quote) }
    model.readSelection = { [weak self] in self?.readSelection() }
    model.decide = { [weak self] id, approved, remember in self?.tell(.decide(approval: id, approved: approved, remember: remember)) }
    model.list = { [weak self] in self?.tell(.list) }
    model.switchTo = { [weak self] id in self?.tell(.switchTo(conversation: id)) }
    model.chooseModel = { [weak self] choice in self?.tell(.model(choice)) }
    model.setAuto = { [weak self] on in self?.tell(.auto(on)) }
    model.askMentions = { [weak self] q in self?.tell(.mentions(q)) }
    model.close = { [weak self] in self?.close() }
    watchFront()
    front.note(NSWorkspace.shared.frontmostApplication)
  }

  var isOpen: Bool { window.isVisible }

  func toggle() {
    if isOpen { close() } else { open() }
  }

  /// The window put away: a session its chat holds goes on, so KOS can work the screen behind it.
  private func close() {
    window.orderOut(nil)
  }

  func open() {
    made = true
    noteFront()
    // Up first, then read: becoming key reads it too, and the newer read wins.
    window.present()
    readSelection()
    refresh(asking: true)
  }

  /// The lines or the pairings changed: the window follows the KOS it speaks of, and one that just came on is asked for the chat.
  func refresh(asking: Bool = false) {
    let now = target()
    let other = now?.id != talkingTo
    if other { model.reset() }
    talkingTo = now?.id
    if other { scope() }
    model.paired = now != nil
    model.kosName = now?.name
    model.online = now?.online ?? false
    if let id = now?.id { model.face = faceOf(id) }
    let cameOn = model.online && (!wasOnline || other)
    wasOnline = model.online
    if isOpen, model.online, asking || cameOn {
      tell(.open)
      tell(.models)
      waitForShow()
    }
  }

  /// A KOS that is on and never shows the chat is one from before this window: said, rather than an empty window.
  private func waitForShow() {
    showing?.invalidate()
    showing = Timer.scheduledTimer(withTimeInterval: Self.showWithin, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self, self.model.online else { return }
        self.model.silent = true
      }
    }
  }

  /// A chat call from a KOS. Only the one the window talks to is drawn; every one is answered.
  func handle(_ call: Call, _ method: ChatMethod, from origin: String) -> Data? {
    guard origin == talkingTo else { return try? Outbound.reply(id: call.id, result: EmptyResult()) }
    do {
      switch method {
      case .show:
        let p = try call.params(ChatShow.self)
        heardBack()
        showing?.invalidate()
        showing = nil
        model.silent = false
        model.show(
          conversation: p.chat ?? p.conversation, title: p.title, lines: p.messages.compactMap(Self.line),
          notice: p.notice.map { ($0.text, $0.from, $0.waiting ?? false) }, auto: p.auto ?? false,
          pictures: Dictionary(uniqueKeysWithValues: (p.pictures ?? [:]).compactMap { k, v in Int(k).map { ($0, v) } }))
        scope()
      case .status:
        let p = try call.params(ChatStatus.self)
        heardBack()
        // A step's picture comes on its own: the turn's story is told apart, and is not ended by it.
        if let frame = p.frame {
          model.frame(frame.id, image: frame.image, said: p.said, conversation: p.turnChat)
          return try? Outbound.reply(id: call.id, result: EmptyResult())
        }
        model.status(
          taken: p.taken ?? false, story: p.story, error: p.error, said: p.said, conversation: p.turnChat,
          waiting: p.waiting.flatMap { ChatModel.Wait(rawValue: $0.rawValue) }, held: p.held ?? false)
      case .ask:
        let a = try call.params(ChatAsk.self).approval
        model.ask(.init(
          id: a.id, tool: a.tool, args: a.args, mechanics: a.mechanics, why: a.why, reason: a.reason, always: a.always,
          expires: a.expiresAt.map { Date(timeIntervalSince1970: $0 / 1000) }))
      case .settled:
        model.settled(try call.params(ChatSettled.self).approval)
      case .chats:
        let p = try call.params(ChatChats.self)
        model.chats(p.chats.map { .init(id: $0.id, title: $0.title, updated: Date(timeIntervalSince1970: $0.updatedAt / 1000)) })
      case .models:
        let p = try call.params(ChatModels.self)
        model.models(.init(current: p.current, choices: p.choices, fixed: p.fixed), error: p.error)
      case .mentions:
        let p = try call.params(ChatMentions.self)
        model.mentions(p.mentions.map { .init(kind: $0.kind, id: $0.id, label: $0.label, hint: $0.hint) }, for: p.q)
      }
      return try? Outbound.reply(id: call.id, result: EmptyResult())
    } catch let error as DeviceError {
      return try? Outbound.reply(id: call.id, error: error)
    } catch {
      return try? Outbound.reply(id: call.id, error: DeviceError(.internal, error.localizedDescription))
    }
  }

  /// The session and the ask, as the window shows them: only when they are this chat's, on the KOS it talks to.
  private func scope() {
    let session = self.session.flatMap { isMine(origin: $0.origin, conversation: $0.conversation) ? $0 : nil }
    let asking = self.asking.flatMap { isMine(origin: $0.origin, conversation: $0.conversation) ? $0 : nil }
    model.session = session.map { $0.paused ? .paused : .working }
    model.consent = asking.map { ChatModel.Consent(task: $0.task, until: $0.until) }
  }

  /// One entry of the chat as KOS sends it, as the window draws it.
  private static func line(_ m: ChatMessage) -> ChatModel.Line? {
    switch m.role {
    case "you": return .you(m.text ?? "", files: m.files ?? [], quote: m.quote.map { .init(text: $0.text, from: $0.from) })
    case "kos": return m.text.map { .kos($0) }
    case "note": return m.text.map { .note($0) }
    case "steps": return .steps((m.steps ?? []).map { .init(summary: $0.summary, failed: $0.failed ?? false, frame: $0.frame) })
    default: return nil
    }
  }

  // MARK: The owner

  private func say(_ text: String, quote: ChatModel.Quote?) {
    tell(.send(text: text, beside: beside(), quote: quote.map { Quote(text: $0.text, from: $0.from) }))
    // KOS says it has the words at once; nothing back in a while is a KOS that cannot talk here.
    taking?.invalidate()
    taking = Timer.scheduledTimer(withTimeInterval: Self.takeWithin, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated {
        self?.model.giveBack("KOS did not take that. It may be a KOS without the Mac window, or not reachable now; your words are back in the box.")
      }
    }
  }

  /// While KOS's pointer acts, the window lets it through to the app under it.
  func letThrough(_ on: Bool) {
    guard made else { return }
    window.ignoresMouseEvents = on
  }

  /// Before KOS types, the box gives up the keyboard: the app the owner was in before the chat comes back to the
  /// front, so the keys land there. AppKit gives a window the keyboard only by activating another app, never by
  /// telling the window to resign it. Waits a moment for the switch; the caller still refuses if it did not happen.
  func yieldKeys() async {
    guard made, window.isKeyWindow, let app = front.last, !app.isTerminated else { return }
    NSApp.yieldActivation(to: app)
    app.activate()
    var waited = 0
    while window.isKeyWindow, waited < Self.yieldChecks {
      try? await Task.sleep(nanoseconds: 50_000_000)
      waited += 1
    }
  }

  /// How many times, 50 ms apart, the chat looks for the keyboard to have gone before KOS types.
  private static let yieldChecks = 10

  /// Whether a session or an ask, by the KOS and chat it is for, is this window's chat's.
  func isMine(origin: String, conversation: String?) -> Bool {
    origin == talkingTo && conversation != nil && conversation == model.conversation
  }

  /// KOS stops the chat's turn, ends its sessions here and withdraws any ask for one.
  func tellStop() {
    tell(.stop)
  }

  private func heardBack() {
    taking?.invalidate()
    taking = nil
  }

  private func tell(_ event: ChatEvent) {
    guard let id = talkingTo, let frame = try? event.frame() else { return }
    send?(id, frame)
  }

  // MARK: The app in front

  /// Where the owner was: the app in front of the window, one they hid, or none. KOS for Mac itself is never it.
  private func beside() -> Beside {
    guard let app = frontApp() else { return .none }
    if isHidden(app.bundleIdentifier) { return .hidden }
    return .app(name: app.localizedName ?? app.bundleIdentifier ?? "an app", bundle: app.bundleIdentifier, title: Self.windowTitle(of: app.processIdentifier))
  }

  private func frontApp() -> NSRunningApplication? {
    front.beside(front: NSWorkspace.shared.frontmostApplication)
  }

  /// The window says which app "this" is, and follows the owner as they move between apps.
  private func watchFront() {
    guard frontWatch == nil else { return }
    frontWatch = NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
    ) { [weak self] note in
      let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
      MainActor.assumeIsolated {
        guard let self else { return }
        self.front.note(app)
        if self.made { self.noteFront() }
      }
    }
  }

  private func noteFront() {
    front.note(NSWorkspace.shared.frontmostApplication)
    let app = frontApp()
    model.beside = app?.localizedName
    let hidden = app.map { isHidden($0.bundleIdentifier) } ?? false
    model.besideHidden = hidden
    // A hidden app's window title stays on the Mac and out of the window both.
    model.besideTitle = hidden ? nil : app.flatMap { Self.windowTitle(of: $0.processIdentifier) }
  }

  /// How long an app that was just asked for its Accessibility tree is given to build it.
  private static let treeWait: UInt64 = 200_000_000
  private static let accessHint = "Allow Accessibility for KOS for Mac, in System Settings, Privacy & Security, to bring in what you select."

  /// What the owner selected in the app beside the window (SelectionReader). Never from a password field, nor from
  /// an app they hid from KOS. Asked again while a read is going (the window up, then the box focused), it reads
  /// once more after it, so the newest answer is shown and an app building its tree is not read half built.
  private func readSelection() {
    guard reading == nil else {
      readAgain = true
      return
    }
    guard let app = frontApp() else { return model.selected(nil) }
    let target = SelectionApp(pid: app.processIdentifier, bundle: app.bundleIdentifier)
    let hidden = isHidden(app.bundleIdentifier)
    reading = Task { [weak self] in
      guard let self else { return }
      let read = await selection.read(target, hidden: hidden, secureInput: { Targets.passwordFieldHasFocus }) {
        try? await Task.sleep(nanoseconds: Self.treeWait)
      }
      reading = nil
      guard !readAgain else {
        readAgain = false
        return readSelection()
      }
      show(read, from: app)
    }
  }

  private func show(_ read: SelectionRead, from app: NSRunningApplication) {
    if read == .untrusted, !toldAccess {
      toldAccess = true
      model.hint = Self.accessHint
    } else if read != .untrusted {
      model.hint = nil
    }
    guard case .text(let text) = read else { return model.selected(nil) }
    let name = app.localizedName ?? app.bundleIdentifier ?? "an app"
    let from = Self.windowTitle(of: app.processIdentifier).map { "\(name): \($0)" } ?? name
    model.selected(.init(text: text, from: from))
  }

  /// The front window of an app, by its title, when macOS will say it.
  private static func windowTitle(of pid: pid_t) -> String? {
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    let front = list.first { ($0[kCGWindowOwnerPID as String] as? pid_t) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }
    let title = (front?[kCGWindowName as String] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
    return title?.isEmpty == false ? title : nil
  }
}
