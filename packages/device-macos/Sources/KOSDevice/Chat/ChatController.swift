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
  /// The KOS the window talks to: its id, what to call it when there are several, and where its line stands.
  var target: () -> (id: String, name: String?, link: LinkState)? = { nil }
  var faceOf: (String) -> FaceLook = { _ in .kos }
  var isHidden: (String?) -> Bool = { _ in false }
  /// The fields KOS typed a secret into this session: the selection is never read from them.
  var typedFields: () -> [AXUIElement] = { [] }
  /// The session on this Mac, and the ask for one, by the KOS and the chat they are for: the window shows its own chat's alone.
  var session: (origin: String, conversation: String?, paused: Bool)? { didSet { scope() } }
  var asking: (origin: String, conversation: String?, task: String, until: Date)? { didSet { scope() } }
  /// Told after each call from KOS is drawn: the menu bar follows the turn.
  var onDrawn: (() -> Void)?

  private lazy var window: ChatWindow = {
    let window = ChatWindow(model: model)
    window.onKey = { [weak self] in self?.readSelection() }
    // Back from another app, the owner may have selected something else in the same field: read as on opening.
    window.onResign = { [weak self] in self?.openRead = true }
    return window
  }()
  /// Whether the window was ever made: stepping aside does not make one.
  private var made = false
  /// What KOS works in while a session runs, in AppKit's screen points: the window keeps clear of it.
  private var workingIn: CGRect?
  /// The window put away for the session, and where it stood when the session began.
  private var aside = ChatAside()
  private var before: CGRect?
  private var talkingTo: String?
  private var wasOnline = false
  private var taking: Timer?
  /// Set while the window waits for a KOS that is on to show the chat.
  private var showing: Timer?
  /// The app the owner was in, watched from launch so it is known when the window first opens over KOS for Mac's own.
  private var front = FrontTracker<NSRunningApplication> { $0.processIdentifier == ProcessInfo.processInfo.processIdentifier }
  private var frontWatch: NSObjectProtocol?
  private var quitWatch: NSObjectProtocol?
  /// Whether each running app is built on Chromium, looked up in its bundle once rather than on every read.
  private var chromium = PerProcess<Bool>()
  private let selection = SelectionReader(Accessibility())
  /// Where the selection is read, off the main thread: an app slow to answer holds this queue, not the windows.
  private let selectionQueue = DispatchQueue(label: "kos.selection", qos: .userInitiated)
  private var reading = false
  private var readAgain = false
  /// Set as the window opens, or gives the keyboard up: the next read is made whatever the last one found.
  private var openRead = false
  /// The owner was told once that without Accessibility the window cannot bring in what they select.
  private var toldAccess = false

  /// How long the window waits to hear that KOS has the owner's words before it gives them back.
  private static let takeWithin: TimeInterval = 12
  /// How long a KOS that is on has to show the chat, as the side panel waits, before the window says it cannot talk here.
  private static let showWithin: TimeInterval = 6

  init() {
    model.send = { [weak self] text, quote in self?.say(text, quote: quote) }
    model.readSelection = { [weak self] in self?.readSelection() }
    model.decide = { [weak self] id, approved, remember, code in self?.tell(.decide(approval: id, approved: approved, remember: remember, code: code)) }
    model.list = { [weak self] in self?.tell(.list) }
    model.switchTo = { [weak self] id in self?.tell(.switchTo(conversation: id)) }
    model.chooseModel = { [weak self] choice in self?.tell(.model(choice)) }
    model.setMode = { [weak self] mode in self?.tell(.mode(mode)) }
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
    // Opened by the owner while it stood aside, it is theirs again.
    _ = aside.take(.opened)
    noteFront()
    // One read for the opening: becoming key, this, and the box taking focus all ask, and only the first reads.
    openRead = true
    window.present()
    readSelection()
    refresh(asking: true)
  }

  /// The lines or the pairings changed: the window follows the KOS it speaks of, and one that just came on is asked for the chat.
  func refresh(asking: Bool = false) {
    let now = target()
    let other = now?.id != talkingTo
    if other {
      model.reset()
      model.source = now?.id ?? ""
    }
    talkingTo = now?.id
    if other { scope() }
    model.paired = now != nil
    model.kosName = now?.name
    model.link = now?.link
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
      switch try ChatCalls.draw(call, as: method, into: model) {
      case .shown:
        showing?.invalidate()
        showing = nil
        // Words the chat does not have yet are still KOS's to take: the wait on them goes on.
        if model.sending.isEmpty { heardBack() }
        scope()
      case .status:
        heardBack()
      case .other:
        break
      }
      onDrawn?()
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

  // MARK: While KOS works this Mac

  /// A session's target, or none once it ends, and whether its turn needs the owner. Live, the window drops under
  /// what KOS works in and steps aside when it covers it; it comes back, without taking the front, when the owner is
  /// needed (clear of the target) or the session ends (where it stood).
  func keepClear(of target: CGRect?, needsOwner: Bool) {
    let was = workingIn
    workingIn = target
    guard made else { return }
    if let target {
      window.level = .normal
      if was == nil {
        before = window.frame
        // Words being typed in it stay where they are typed: the owner is in the window, not out of KOS's way.
        let typing = window.isKeyWindow && !model.draft.isEmpty
        move(aside.take(.live(open: isOpen, covers: ChatPlacement.covers(window.frame, target: target), typing: typing)))
      }
      if needsOwner { move(aside.take(.needsOwner)) }
    } else if was != nil {
      window.level = .floating
      move(aside.take(.ended))
    }
  }

  private func move(_ move: ChatAside.Move) {
    switch move {
    case .stay:
      return
    case .hide:
      window.orderOut(nil)
    case .show(let clear):
      if clear, let target = workingIn {
        stand(clearOf: target)
      } else if let before {
        window.setFrame(before, display: false)
      }
      // Up, never key: the app KOS works in, or the owner's, keeps the keyboard.
      window.orderFrontRegardless()
    case .restore:
      if let before { window.setFrame(before, display: false) }
    }
  }

  /// Beside what KOS works in on its screen, or on another screen when the whole of that one is shared.
  private func stand(clearOf target: CGRect) {
    let frame = window.frame
    let here = NSScreen.screens.first { $0.frame.intersects(target) } ?? window.screen ?? NSScreen.main
    if let here, let to = ChatPlacement.clear(of: target, window: frame, in: here.visibleFrame) {
      window.setFrameOrigin(to)
    } else if let other = NSScreen.screens.first(where: { !$0.frame.intersects(target) }) {
      window.setFrameOrigin(ChatPlacement.onAnother(other.visibleFrame, window: frame, from: here?.frame ?? target))
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
    quitWatch = NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main
    ) { [weak self] note in
      guard let pid = (note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.processIdentifier else { return }
      MainActor.assumeIsolated { self?.chromium.forget(pid) }
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
  private static let treeWait: TimeInterval = 0.2
  private static let accessHint = "Allow Accessibility for KOS for Mac, in System Settings, Privacy & Security, to bring in what you select."

  /// What the owner selected in the app beside the window (SelectionReader), read on its own queue. Never from a
  /// password field or one KOS typed a secret into, nor from an app they hid from KOS. The opening reads; asked again after (the box focused), it
  /// reads only when the app or its focused element changed, and asked while a read is going, once more after it.
  private func readSelection() {
    guard !reading else {
      readAgain = true
      return
    }
    guard let app = frontApp() else { return model.selected(nil) }
    let target = SelectionApp(pid: app.processIdentifier, bundle: app.bundleIdentifier, chromiumBased: chromium.value(for: app.processIdentifier) { Self.chromiumBased(app) })
    let hidden = isHidden(app.bundleIdentifier)
    let onlyIfChanged = !openRead
    openRead = false
    reading = true
    let reader = selection
    let wait = Self.treeWait
    let typed = typedFields()
    selectionQueue.async { [weak self] in
      let read = reader.read(target, hidden: hidden, onlyIfChanged: onlyIfChanged, skipping: { typed.contains($0) }, secureInput: { Targets.passwordFieldHasFocus }) {
        Thread.sleep(forTimeInterval: wait)
      }
      DispatchQueue.main.async {
        MainActor.assumeIsolated { self?.read(read, from: app) }
      }
    }
  }

  /// KOS for Mac is quitting: a flag an app would not take back after a read is put back before it goes.
  func quitting() {
    let reader = selection
    selectionQueue.sync { reader.restore() }
  }

  /// A read came back: shown unless nothing changed, then made again if it was asked for meanwhile.
  private func read(_ read: SelectionRead?, from app: NSRunningApplication) {
    reading = false
    if let read { show(read, from: app) }
    if readAgain {
      readAgain = false
      readSelection()
    }
  }

  /// The frameworks an app built on Chromium carries: Electron's, or Chromium Embedded's.
  private static let chromiumFrameworks = ["Electron Framework.framework", "Chromium Embedded Framework.framework"]

  /// Whether the app is an Electron or Chromium Embedded one, by the framework in its bundle: two file checks.
  private static func chromiumBased(_ app: NSRunningApplication) -> Bool {
    guard let frameworks = app.bundleURL?.appendingPathComponent("Contents/Frameworks") else { return false }
    return chromiumFrameworks.contains { FileManager.default.fileExists(atPath: frameworks.appendingPathComponent($0).path) }
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
