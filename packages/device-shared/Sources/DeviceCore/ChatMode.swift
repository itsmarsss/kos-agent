import Foundation

/// A chat's mode: how KOS treats a risky step in it (docs/browser-extension.md, The chat's mode).
///
/// Ask, the default, asks the owner before each one. Auto goes ahead without asking, for the owner's own turns in
/// that chat, within what Auto never covers. KOS alone decides what it lets through; a device only shows the mode
/// and sets it. The words are the dashboard's (`packages/shared/src/chatmode.ts`), word for word.
public struct ChatMode: Codable, Equatable, Sendable {
  public enum Name: String, Codable, CaseIterable, Sendable {
    case ask, auto
  }

  /// When Auto ends of itself: at a moment, or when the chat's running or next turn finishes.
  public enum Until: Equatable, Sendable {
    case at(Date)
    case task
  }

  public var mode: Name
  /// None lasts until the owner turns it off.
  public var until: Until?
  /// Auto also starts Mac and Chrome sessions the device leaves to KOS's approvals.
  public var sessions: Bool

  public init(_ mode: Name, until: Until? = nil, sessions: Bool = false) {
    self.mode = mode
    self.until = mode == .auto ? until : nil
    self.sessions = mode == .auto && sessions
  }

  public static let ask = ChatMode(.ask)

  /// The mode after this one, round the cycle.
  public var next: Name {
    let all = Name.allCases
    return all[(all.firstIndex(of: mode)! + 1) % all.count]
  }

  /// The mode after this one: Ask to Auto with no bounds, Auto back to Ask. The chip goes into Auto only from its menu.
  /// Only the menu sets Auto's bounds.
  public var cycled: ChatMode {
    next == .auto ? ChatMode(.auto) : .ask
  }

  /// A mode picked in the menu: Ask, or Auto keeping sessions if they were on.
  public func picking(_ name: Name) -> ChatMode {
    name == .ask ? .ask : ChatMode(.auto, until: mode == .auto ? until : nil, sessions: sessions)
  }

  /// A span picked in the menu: Auto for that long, sessions kept.
  public func lasting(_ span: Span, now: Date) -> ChatMode {
    ChatMode(.auto, until: span.until(now: now), sessions: sessions)
  }

  /// The sessions switch, which only Auto has.
  public func starting(sessions: Bool) -> ChatMode {
    ChatMode(mode, until: until, sessions: sessions)
  }

  /// The mode as it stands at `now`: Ask once Auto's time ran out.
  public func live(now: Date) -> ChatMode {
    guard mode == .auto else { return .ask }
    if case .at(let end) = until, end <= now { return .ask }
    return self
  }

  /// The chip's word: the mode, with how long Auto has left when it ends of itself.
  public func label(now: Date) -> String {
    let live = live(now: now)
    switch (live.mode, live.until) {
    case (.ask, _): return "Ask"
    case (.auto, .task): return "Auto · this task"
    case (.auto, .at(let end)): return "Auto · \(Self.leftWords(end.timeIntervalSince(now)))"
    case (.auto, nil): return "Auto"
    }
  }

  /// The chip's tooltip: the mode, what it does, and how to change it; `keys` for a pointer's press, else a tap.
  public func tip(now: Date, keys: Bool = true) -> String {
    let live = live(now: now)
    let press = keys ? "Press" : "Tap"
    let change = live.mode == .auto ? "\(press) for Ask; more in the menu." : "\(press) to choose a mode."
    return "\(live.label(now: now)): \(Self.does(live.mode)) \(change)"
  }

  /// Time left, as a person says it: "45m", "7h", "7h 40m", "under a minute".
  public static func leftWords(_ seconds: TimeInterval) -> String {
    let minutes = Int((seconds / 60).rounded(.down))
    if minutes < 1 { return "under a minute" }
    let h = minutes / 60
    let m = minutes % 60
    return h == 0 ? "\(m)m" : m == 0 ? "\(h)h" : "\(h)h \(m)m"
  }

  /// What a mode does, for the tooltip and the menu.
  public static func does(_ mode: Name) -> String {
    switch mode {
    case .ask: "KOS asks you before anything risky in this chat."
    case .auto:
      "KOS goes ahead without asking for risky steps you start in this chat, in its own browser, your Chrome and your Mac too. Each one is in the Inbox as approved by auto mode."
    }
  }

  /// What a mode does in a few words, for the menu.
  public static func short(_ mode: Name) -> String {
    switch mode {
    case .ask: "Asks you before anything risky"
    case .auto: "Goes ahead without asking; each step is in the Inbox"
    }
  }

  /// How long Auto may be set for, as the chip's menu offers it.
  public enum Span: String, CaseIterable, Sendable {
    case off, task, hour, eight

    public var label: String {
      switch self {
      case .off: "Until I turn it off"
      case .task: "Until this task finishes"
      case .hour: "For 1 hour"
      case .eight: "For 8 hours"
      }
    }

    /// The same in a word or two, for a chip.
    public var short: String {
      switch self {
      case .off: "Until off"
      case .task: "This task"
      case .hour: "1 hour"
      case .eight: "8 hours"
      }
    }

    /// The `until` this span sets, from `now`.
    public func until(now: Date) -> Until? {
      switch self {
      case .off: nil
      case .task: .task
      case .hour: .at(now.addingTimeInterval(3600))
      case .eight: .at(now.addingTimeInterval(8 * 3600))
      }
    }
  }

  /// The span Auto was set for, to light its line in the menu; nil for an hour count, which the chip counts down.
  public var span: Span? {
    switch until {
    case nil: .off
    case .task: .task
    case .at: nil
    }
  }

  /// What Auto never covers: it asks as Ask does, or refuses, whatever the chat is set to. KOS enforces it.
  public static let never: [String] = [
    "Anything KOS refuses outright; Stop and the kill switch always win, and the kill switch turns Auto off",
    "Secrets, and any step marked to ask every time",
    "Purchases and payments: paying tools, and steps on a checkout or card page",
    "Deleting for good: a whole folder, a destructive command, a permanent delete, or a delete outside the workspace",
    "A shell command past reading, building and testing, and any shell or Python run where nothing narrower than the container holds the network",
    "Writing into another project or a blob's folder, or the whole workspace from one",
    "Messages, posts, reactions and roles anyone but you sees, data sent to a site you have not listed, and opening a place to others",
    "Changing KOS itself or what runs without you: a skill, a module, an app, a site, a schedule, a coding agent",
    "Running script in a page, or handing a page to you",
    "Typing where a computer reported a password field",
    "Anything but your own words in this chat: a schedule, a guest, work another chat passed on",
    "A device's own ask for a session, and its time limits",
  ]

  /// The sessions setting, as the menu says it.
  public static let sessionsLabel = "Start sessions too"
  public static let sessionsHint = "On a Mac or Chrome that leaves its sessions to KOS. One that asks on itself still asks there."

  // MARK: The wire: { mode, until?: epoch ms | "task", sessions? }

  enum CodingKeys: String, CodingKey { case mode, until, sessions }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    let mode = try c.decode(Name.self, forKey: .mode)
    var until: Until?
    if let word = try? c.decodeIfPresent(String.self, forKey: .until) {
      until = word == "task" ? .task : nil
    } else if let ms = try? c.decodeIfPresent(Double.self, forKey: .until), ms.isFinite, ms > 0 {
      until = .at(Date(timeIntervalSince1970: ms / 1000))
    }
    let sessions = (try? c.decodeIfPresent(Bool.self, forKey: .sessions)) ?? false
    self.init(mode, until: until, sessions: sessions == true)
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(mode, forKey: .mode)
    switch until {
    case .task: try c.encode("task", forKey: .until)
    case .at(let end): try c.encode((end.timeIntervalSince1970 * 1000).rounded(), forKey: .until)
    case nil: break
    }
    if sessions { try c.encode(true, forKey: .sessions) }
  }
}
