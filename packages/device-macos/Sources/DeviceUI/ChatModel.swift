import Foundation

/// The chat in KOS for Mac's window, as it stands and as it goes: what KOS
/// last showed, the owner's words on their way, the running turn's steps,
/// and what waits on the owner. The side panel's chat, kept the same way
/// (packages/browser-extension panel.tsx): the transcript KOS shows is the
/// truth, and the owner's words leave the waiting ones as they arrive in it.
/// The window draws it; the app fills it from the line and sends on what the
/// owner does.
@MainActor
public final class ChatModel: ObservableObject {
  public enum Line: Equatable {
    case you(String, files: [String])
    case kos(String)
    case note(String)
    case steps([Step])
  }

  public struct Step: Equatable, Sendable {
    public let summary: String
    public let failed: Bool
    /// The frame id of what it saw, when it kept a picture.
    public let frame: Int?

    public init(summary: String, failed: Bool = false, frame: Int? = nil) {
      self.summary = summary
      self.failed = failed
      self.frame = frame
    }
  }

  /// How many step pictures the window keeps; the oldest go first.
  public static let picturesKept = 40

  /// An approval to decide here.
  public struct Ask: Equatable, Identifiable, Sendable {
    public let id: String
    public let tool: String
    public let args: String?
    /// What the step does, action by action, when its words are the model's account of it.
    public let mechanics: String?
    public let why: String?
    public let reason: String?
    /// The words of a yes that is remembered, when one may be.
    public let always: String?

    public init(id: String, tool: String, args: String? = nil, mechanics: String? = nil, why: String? = nil, reason: String? = nil, always: String? = nil) {
      self.id = id
      self.tool = tool
      self.args = args
      self.mechanics = mechanics
      self.why = why
      self.reason = reason
      self.always = always
    }
  }

  /// A chat the window may continue.
  public struct Pick: Equatable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let updated: Date

    public init(id: String, title: String, updated: Date) {
      self.id = id
      self.title = title
      self.updated = updated
    }
  }

  public struct Models: Equatable, Sendable {
    public let current: String
    public let choices: [String]
    /// An engine that chooses its own, named; nothing to pick then.
    public let fixed: String?

    public init(current: String, choices: [String], fixed: String? = nil) {
      self.current = current
      self.choices = choices
      self.fixed = fixed
    }
  }

  /// A KOS the window may talk to.
  public struct KOSChoice: Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String

    public init(id: String, name: String) {
      self.id = id
      self.name = name
    }
  }

  public enum Session: Equatable, Sendable { case working, paused }

  /// What a turn waits on the owner for, as KOS says it.
  public enum Wait: String, Equatable, Sendable { case consent, approval }

  /// A session asked for on this Mac's screen by this chat: what for, and when it says no by itself.
  public struct Consent: Equatable, Sendable {
    public let task: String
    public let until: Date

    public init(task: String, until: Date) {
      self.task = task
      self.until = until
    }
  }

  /// A turn's steps so far, "› " before each, and the owner's words it is about, when KOS said.
  public struct Story: Equatable, Sendable {
    public let said: String?
    public let text: String
  }

  /// The frame ids a turn on the go saw, oldest first, by the words it is about.
  public struct Live: Equatable, Sendable {
    public let said: String?
    public var frames: [Int]
  }

  /// What was answered outside the chat's words, placed after the owner's `after`th message.
  public struct Notice: Equatable, Sendable {
    public let after: Int
    public let text: String
    public let from: String?
    /// A turn waiting on the owner: gone once the chat is shown again.
    public let waiting: Bool
  }

  @Published public private(set) var conversation: String?
  @Published public private(set) var title = "KOS"
  @Published public private(set) var lines: [Line] = []
  /// The owner's words sent, and not yet in the chat.
  @Published public private(set) var sending: [String] = []
  @Published public private(set) var notices: [Notice] = []
  @Published public private(set) var working = false {
    didSet { if working != oldValue { workingSince = working ? Date() : nil } }
  }
  /// When the running turn began, as this window saw it: what the foot counts from.
  @Published public private(set) var workingSince: Date?
  /// The words of the turn KOS last took: a turn queued behind another starts its own clock.
  private var takenWords: String?
  /// The story of each turn on the go, under the words it is about: one running, and one said meanwhile.
  @Published public private(set) var stories: [Story] = []
  /// What each turn on the go saw, by the words it is about.
  @Published public private(set) var live: [Live] = []
  /// The steps' pictures, JPEG by frame id: sent as each step ran, and with the chat as it stands.
  @Published public private(set) var pictures: [Int: Data] = [:]
  /// The order pictures came in, so the oldest go first past the cap.
  private var pictureOrder: [Int] = []
  @Published public private(set) var asks: [Ask] = []
  @Published public private(set) var chats: [Pick] = []
  @Published public private(set) var models: Models?
  @Published public private(set) var auto = false
  @Published public var error: String?
  /// What the box holds: typed, or words KOS never took, given back.
  @Published public var draft = "" {
    didSet { if draft != oldValue { typed() } }
  }
  /// What an @ may name, as KOS last answered it, for the start of it asked.
  @Published public private(set) var mentionsFor = ""
  @Published public private(set) var mentions: [ChatMenus.Mention] = []
  /// The token the owner closed the menu on, so it stays closed until they type on.
  @Published public private(set) var menuClosedAt: String?
  private var mentionAsk: Task<Void, Never>?
  /// The app in front of the window, which "this" means: its name, or nil for none.
  @Published public var beside: String?
  /// That app's front window, by its title, when macOS says it.
  @Published public var besideTitle: String?
  /// The app in front is one the owner hid from KOS.
  @Published public var besideHidden = false
  /// This chat's session on this Mac, working or paused for the owner: what the app card says of the app in front.
  @Published public var session: Session?
  /// This chat's ask for a session, up on the owner's screen.
  @Published public var consent: Consent?
  /// What KOS says the running turn waits on the owner for.
  @Published public private(set) var waiting: Wait?
  /// KOS says the owner has the Mac, and the turn waits for it back.
  @Published public private(set) var held = false
  /// Whether this Mac is paired with any KOS at all.
  @Published public var paired = false
  @Published public var online = false
  /// The KOS is on and never showed the chat: one from before this window, that cannot talk here.
  @Published public var silent = false
  /// Which KOS this is, when the Mac is paired with more than one.
  @Published public var kosName: String?
  /// Every KOS this Mac is paired with, to choose which one the window talks to; one is no choice.
  @Published public var kosChoices: [KOSChoice] = []
  /// The face of the KOS this window talks to.
  @Published public var face: FaceLook = .kos

  /// What the owner does, for the app to send on.
  public var send: (String) -> Void = { _ in }
  public var decide: (_ approval: String, _ approved: Bool, _ remember: Bool) -> Void = { _, _, _ in }
  public var list: () -> Void = {}
  public var switchTo: (String) -> Void = { _ in }
  public var chooseModel: (String) -> Void = { _ in }
  public var setAuto: (Bool) -> Void = { _ in }
  public var close: () -> Void = {}
  public var chooseKOS: (String) -> Void = { _ in }
  /// What an @ may name, by the start of it.
  public var askMentions: (String) -> Void = { _ in }
  /// Stop this chat's turn, its session and any ask for one.
  public var stop: () -> Void = {}
  /// Give the Mac back to KOS after taking it over.
  public var handBack: () -> Void = {}

  public init() {}

  // MARK: The owner

  /// The owner's words. A command (/new) is never in the chat's words, so it waits for nothing but its answer.
  public func say(_ text: String) {
    let said = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !said.isEmpty else { return }
    error = nil
    if !said.hasPrefix("/") { sending.append(said) }
    working = true
    send(said)
  }

  /// An approval answered: its card goes at once, and a yes goes on working.
  public func answer(_ id: String, approved: Bool, remember: Bool = false) {
    guard asks.contains(where: { $0.id == id }) else { return }
    asks.removeAll { $0.id == id }
    if approved { working = true }
    decide(id, approved, remember)
  }

  // MARK: KOS

  /// The chat as KOS says it stands now.
  public func show(conversation: String?, title: String, lines: [Line], notice: (text: String, from: String?, waiting: Bool)? = nil, auto: Bool = false, pictures: [Int: String] = [:]) {
    let fresh = conversation != self.conversation && self.conversation != nil
    if fresh {
      self.pictures = [:]
      pictureOrder = []
    }
    for (id, image) in pictures.sorted(by: { $0.key < $1.key }) { keepPicture(id, image) }
    let said = lines.compactMap { line -> String? in
      if case .you(let text, _) = line { return text }
      return nil
    }
    sending = fresh ? [] : sending.filter { !said.contains($0) }
    var kept = fresh ? [] : notices.filter { !$0.waiting }
    if let notice { kept.append(Notice(after: said.count, text: notice.text, from: notice.from, waiting: notice.waiting)) }
    notices = kept
    let lastIsYours: Bool = {
      if case .you = lines.last { return true }
      return false
    }()
    let answered = sending.isEmpty && (notice != nil || !lastIsYours)
    working = !sending.isEmpty || (working && !answered)
    if answered {
      stories = []
      live = []
    }
    if fresh { asks = [] }
    self.conversation = conversation
    self.title = title
    self.lines = lines
    self.auto = auto
  }

  /// A turn as it goes, for the owner's words `said` in `conversation`. `story` is `.some(nil)` when KOS said the turn is done.
  /// Another chat's turn is not this one's: nothing of it is drawn.
  public func status(
    taken: Bool, story: String??, error: String?, said: String? = nil, conversation: String? = nil, waiting: Wait? = nil, held: Bool = false
  ) {
    if let conversation, conversation != self.conversation { return }
    self.waiting = error == nil && story != .some(nil) ? waiting : nil
    self.held = error == nil && story != .some(nil) && held
    if let error {
      self.error = error
      working = false
      stories = []
      live = []
      // What was waiting was never taken: it goes back to the owner.
      if !sending.isEmpty {
        draft = sending.joined(separator: "\n")
        sending = []
      }
      return
    }
    if taken {
      // Words said somewhere else (on the dashboard, in a Chrome) show here on their way, as if typed here.
      guard let said, conversation != nil else { return }
      if !sending.contains(said) && !awaiting(said) { sending.append(said) }
      working = true
      if said != takenWords {
        takenWords = said
        workingSince = Date()
      }
      return
    }
    switch story {
    case .some(.some(let steps)):
      // The steps of a turn the chat already shows answered, told once more as it closed: nothing new.
      if sending.isEmpty, let said, answered(said) { return }
      // Each turn keeps its own: one said meanwhile does not overwrite the one running.
      let next = Story(said: said, text: steps)
      if let at = stories.firstIndex(where: { $0.said == said }) { stories[at] = next } else { stories.append(next) }
      working = true
    case .some(.none):
      // That turn is done; one still going keeps the foot.
      stories.removeAll { said == nil || $0.said == said }
      live.removeAll { said == nil || $0.said == said }
      working = !stories.isEmpty
    case .none:
      break
    }
  }

  /// A step's picture as the turn on `said` takes it, in `conversation`: kept, and shown under its steps.
  public func frame(_ id: Int, image: String, said: String? = nil, conversation: String? = nil) {
    guard conversation == self.conversation, keepPicture(id, image) else { return }
    if let at = live.firstIndex(where: { $0.said == said }) {
      live[at].frames = live[at].frames.filter { $0 != id } + [id]
    } else {
      live.append(Live(said: said, frames: [id]))
    }
  }

  /// What every turn on the go saw, oldest first.
  public var liveFrames: [Int] { live.flatMap(\.frames) }

  /// What the turn on `said` saw.
  public func liveFrames(of said: String?) -> [Int] {
    live.first { $0.said == said }?.frames ?? []
  }

  /// The latest turn's steps so far.
  public var story: String? { stories.last?.text }

  /// The pictures of these frame ids that the window has, in order.
  public func picturesOf(_ frames: [Int?]) -> [(id: Int, data: Data)] {
    frames.compactMap { id in id.flatMap { id in pictures[id].map { (id, $0) } } }
  }

  @discardableResult
  private func keepPicture(_ id: Int, _ image: String) -> Bool {
    guard let data = Data(base64Encoded: image), !data.isEmpty else { return false }
    pictures[id] = data
    pictureOrder = pictureOrder.filter { $0 != id } + [id]
    while pictureOrder.count > Self.picturesKept { pictures[pictureOrder.removeFirst()] = nil }
    return true
  }

  /// The owner's latest words, and the lines after them.
  private func after(_ said: String) -> ArraySlice<Line>? {
    guard let at = lines.lastIndex(where: { if case .you = $0 { return true } else { return false } }),
      case .you(let text, _) = lines[at], text == said
    else { return nil }
    return lines[(at + 1)...]
  }

  /// The owner's words are the chat's latest and not yet answered: the turn on them is in the chat already.
  private func awaiting(_ said: String) -> Bool {
    after(said)?.allSatisfy { if case .steps = $0 { return true } else { return false } } ?? false
  }

  /// The owner's latest words have KOS's answer under them.
  private func answered(_ said: String) -> Bool {
    after(said)?.contains { if case .kos = $0 { return true } else { return false } } ?? false
  }

  // MARK: The / and @ menus

  /// How long the box waits on a pause in typing an @ before it asks KOS what it may name.
  static let mentionPause: Duration = .milliseconds(120)

  /// The menu open on what is typed at the end of the box, and its options; nil when there is none.
  public var menu: (token: ChatMenus.Token, options: [ChatMenus.Option])? {
    guard let token = ChatMenus.token(in: draft), token.raw != menuClosedAt else { return nil }
    let options: [ChatMenus.Option]
    switch token.kind {
    case .command: options = ChatMenus.commands(token.q)
    case .mention: options = token.q == mentionsFor ? mentions.map(ChatMenus.option) : []
    }
    return options.isEmpty ? nil : (token, options)
  }

  /// What was picked in the menu, in place of what was typed.
  public func take(_ option: ChatMenus.Option) {
    guard let token = ChatMenus.token(in: draft) else { return }
    draft = ChatMenus.take(option, for: token, in: draft)
  }

  /// Escape: the menu stays closed until the owner types on.
  public func closeMenu() {
    menuClosedAt = ChatMenus.token(in: draft)?.raw
  }

  /// What an @ may name, as KOS answered for the start of it.
  public func mentions(_ list: [ChatMenus.Mention], for q: String) {
    mentionsFor = q
    mentions = list
  }

  private func typed() {
    menuClosedAt = nil
    mentionAsk?.cancel()
    guard let token = ChatMenus.token(in: draft), token.kind == .mention else { return }
    mentionAsk = Task { [weak self] in
      try? await Task.sleep(for: Self.mentionPause)
      guard !Task.isCancelled else { return }
      self?.askMentions(token.q)
    }
  }

  public func ask(_ approval: Ask) {
    asks = asks.filter { $0.id != approval.id } + [approval]
  }

  public func settled(_ id: String) {
    asks.removeAll { $0.id == id }
  }

  public func chats(_ list: [Pick]) {
    chats = list
  }

  public func models(_ models: Models?, error: String? = nil) {
    if let error { self.error = "The model was not changed: \(error)" }
    self.models = error == nil ? models : self.models
  }

  /// Another KOS: nothing of the last one's chat stays.
  public func reset() {
    silent = false
    conversation = nil
    title = "KOS"
    lines = []
    sending = []
    notices = []
    working = false
    stories = []
    live = []
    waiting = nil
    held = false
    pictures = [:]
    pictureOrder = []
    asks = []
    chats = []
    models = nil
    auto = false
    error = nil
  }

  /// Nothing heard back: the words go back in the box, and the window says why.
  public func giveBack(_ why: String) {
    error = why
    working = false
    stories = []
    live = []
    if !sending.isEmpty {
      draft = sending.joined(separator: "\n")
      sending = []
    }
  }

  // MARK: As drawn

  /// The chat can be talked to: a KOS on the line that answers this window.
  public var usable: Bool { online && !silent }

  /// What the header says under KOS: the chat's name, or why there is none, as the side panel says it.
  public var subtitle: String {
    if !paired { return "Not paired yet" }
    if !online { return "Not connected" }
    if silent { return "This KOS cannot talk here yet" }
    return conversation == nil ? "A chat beside your apps" : title
  }

  /// The latest turn's story, as the thread draws it: the steps so far, and what KOS is saying after them.
  public var running: (steps: [Step], words: String) {
    story.map(Self.read) ?? ([], "")
  }

  /// A story as the thread draws it: the steps so far, and what KOS is saying after them.
  public static func read(_ story: String) -> (steps: [Step], words: String) {
    // A long story comes as its tail, cut mid-line after a "…": that first line is a fragment.
    let all = story.components(separatedBy: "\n")
    let lines = (story.hasPrefix("…") ? Array(all.dropFirst()) : all).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
    let steps = lines.filter { $0.hasPrefix(stepMark) }.map { line -> Step in
      let summary = String(line.dropFirst(stepMark.count))
      let failed = summary.hasSuffix(" (failed)")
      return Step(summary: failed ? String(summary.dropLast(" (failed)".count)) : summary, failed: failed)
    }
    return (steps, lines.filter { !$0.hasPrefix(stepMark) }.joined(separator: "\n"))
  }

  /// An approval or a session ask is up: the running turn is held on the owner, and its foot says so with no dots and no clock.
  public var waitingOnOwner: Bool { !asks.isEmpty || consent != nil || waiting != nil }

  /// The owner took the Mac over from this chat's turn: it waits for them to hand it back.
  public var heldByOwner: Bool { held || session == .paused }

  /// Something of this chat's is going: a turn, a session, or an ask for one. The box's button stops it.
  public var busy: Bool { working || session != nil || consent != nil }

  /// The foot counts the turn's time: it is not waiting on the owner.
  public var footLive: Bool { !waitingOnOwner && !heldByOwner }

  /// What the running turn's foot says it is at, for as long as it runs, whatever came last; nil once it ends.
  /// Paused while the owner has the Mac, waiting on you while an ask is up, thinking before it has shown anything,
  /// its latest step while that is the last thing told, else working.
  public var foot: String? {
    guard working || heldByOwner || consent != nil else { return nil }
    if heldByOwner { return "Paused, you have control" }
    if waitingOnOwner { return "Waiting on you" }
    guard let story else { return "Thinking" }
    let last = story.components(separatedBy: "\n").last { !$0.trimmingCharacters(in: .whitespaces).isEmpty } ?? ""
    if last.hasPrefix(Self.stepMark) && !last.hasSuffix(" (failed)") { return String(last.dropFirst(Self.stepMark.count)) }
    return last.isEmpty ? "Thinking" : "Working"
  }

  /// What marks a step in a story (TurnNarrator's STEP_MARK).
  static let stepMark = "› "

  /// One thing in the thread, in the order it is drawn.
  public enum Item: Equatable, Identifiable {
    case line(Int, Line)
    case notice(Int, Notice)
    case sending(Int, String)
    case story(Int, Story)

    public var id: String {
      switch self {
      case .line(let i, _): return "l\(i)"
      case .notice(let i, _): return "n\(i)"
      case .sending(let i, _): return "s\(i)"
      case .story(let i, _): return "t\(i)"
      }
    }
  }

  /// The chat's words and the words still on their way, with each turn's story and each notice after the exchange it is about.
  public var items: [Item] {
    var out: [Item] = []
    var yours = 0
    var placed = Set<Int>()
    var told = Set<Int>()
    let words = lines.compactMap { line -> String? in
      if case .you(let text, _) = line { return text }
      return nil
    } + sending
    // A story goes after the exchange its words began, or after the latest when they are not there.
    let anchors = stories.map { story in story.said.flatMap { words.lastIndex(of: $0) }.map { $0 + 1 } ?? words.count }
    let place = { (upTo: Int) in
      for (i, story) in self.stories.enumerated() where anchors[i] <= upTo && !told.contains(i) {
        out.append(.story(i, story))
        told.insert(i)
      }
      for (i, notice) in self.notices.enumerated() where notice.after <= upTo && !placed.contains(i) {
        out.append(.notice(i, notice))
        placed.insert(i)
      }
    }
    for (i, line) in lines.enumerated() {
      if case .you = line {
        place(yours)
        yours += 1
      }
      out.append(.line(i, line))
    }
    for (i, text) in sending.enumerated() {
      place(yours)
      yours += 1
      out.append(.sending(i, text))
    }
    place(Int.max)
    return out
  }
}
