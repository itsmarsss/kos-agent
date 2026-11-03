import Foundation

/// The chat in KOS Device's window, as it stands and as it goes: what KOS
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

    public init(summary: String, failed: Bool = false) {
      self.summary = summary
      self.failed = failed
    }
  }

  /// An approval to decide here.
  public struct Ask: Equatable, Identifiable, Sendable {
    public let id: String
    public let tool: String
    public let args: String?
    public let why: String?
    public let reason: String?
    /// The words of a yes that is remembered, when one may be.
    public let always: String?

    public init(id: String, tool: String, args: String? = nil, why: String? = nil, reason: String? = nil, always: String? = nil) {
      self.id = id
      self.tool = tool
      self.args = args
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
  @Published public private(set) var working = false
  /// The running turn's steps, "› " before each.
  @Published public private(set) var story: String?
  @Published public private(set) var asks: [Ask] = []
  @Published public private(set) var chats: [Pick] = []
  @Published public private(set) var models: Models?
  @Published public private(set) var auto = false
  @Published public var error: String?
  /// What the box holds: typed, or words KOS never took, given back.
  @Published public var draft = ""
  /// The app in front of the window, which "this" means: its name, or nil for none.
  @Published public var beside: String?
  /// The app in front is one the owner hid from KOS.
  @Published public var besideHidden = false
  @Published public var online = false
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
  public func show(conversation: String?, title: String, lines: [Line], notice: (text: String, from: String?, waiting: Bool)? = nil, auto: Bool = false) {
    let fresh = conversation != self.conversation && self.conversation != nil
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
    if answered { story = nil }
    if fresh { asks = [] }
    self.conversation = conversation
    self.title = title
    self.lines = lines
    self.auto = auto
  }

  /// A turn as it goes. `story` is `.some(nil)` when KOS said the turn is done.
  public func status(taken: Bool, story: String??, error: String?) {
    if let error {
      self.error = error
      working = false
      self.story = nil
      // What was waiting was never taken: it goes back to the owner.
      if !sending.isEmpty {
        draft = sending.joined(separator: "\n")
        sending = []
      }
      return
    }
    if taken { return }
    switch story {
    case .some(.some(let steps)):
      self.story = steps
      working = true
    case .some(.none):
      working = false
      self.story = nil
    case .none:
      break
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
    conversation = nil
    title = "KOS"
    lines = []
    sending = []
    notices = []
    working = false
    story = nil
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
    story = nil
    if !sending.isEmpty {
      draft = sending.joined(separator: "\n")
      sending = []
    }
  }

  // MARK: As drawn

  /// One thing in the thread, in the order it is drawn.
  public enum Item: Equatable, Identifiable {
    case line(Int, Line)
    case notice(Int, Notice)
    case sending(Int, String)

    public var id: String {
      switch self {
      case .line(let i, _): return "l\(i)"
      case .notice(let i, _): return "n\(i)"
      case .sending(let i, _): return "s\(i)"
      }
    }
  }

  /// The chat's words, with each notice after the owner's message it answers, then the words still on their way.
  public var items: [Item] {
    var out: [Item] = []
    var yours = 0
    var placed = Set<Int>()
    let place = { (upTo: Int) in
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
    place(Int.max)
    for (i, text) in sending.enumerated() { out.append(.sending(i, text)) }
    return out
  }
}
