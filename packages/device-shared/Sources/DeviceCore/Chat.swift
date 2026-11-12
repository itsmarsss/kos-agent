import Foundation

/// The chat KOS draws in this Mac's window: what it calls with, read off the
/// wire. The same calls a Chrome's side panel takes (docs/browser-extension.md);
/// none needs a session, since they carry the chat and not the computer.
public enum ChatMethod: String, CaseIterable, Sendable {
  case show = "chat.show"
  case status = "chat.status"
  case ask = "chat.ask"
  case settled = "chat.settled"
  case chats = "chat.chats"
  case models = "chat.models"
  case mentions = "chat.mentions"
}

public struct ChatStep: Decodable, Equatable, Sendable {
  public let summary: String
  public let failed: Bool?
  /// The frame id of what the step saw, when it kept a picture.
  public let frame: Int?

  public init(summary: String, failed: Bool? = nil, frame: Int? = nil) {
    self.summary = summary
    self.failed = failed
    self.frame = frame
  }
}

/// What a step just saw, sent as the turn runs: its frame id and the picture, base64 JPEG.
public struct ChatFrame: Decodable, Equatable, Sendable {
  public let id: Int
  public let image: String
}

/// One entry in the chat: the owner's words, KOS's, a note, or the steps a turn took.
public struct ChatMessage: Decodable, Equatable, Sendable {
  public let role: String
  public let text: String?
  public let files: [String]?
  public let steps: [ChatStep]?
  /// What the owner quoted with their words, from a page or an app.
  public let quote: Quote?

  public init(role: String, text: String? = nil, files: [String]? = nil, steps: [ChatStep]? = nil, quote: Quote? = nil) {
    self.role = role
    self.text = text
    self.files = files
    self.steps = steps
    self.quote = quote
  }
}

/// What was answered and is not in the chat's words: a command's answer, a turn waiting on the owner.
public struct ChatNotice: Decodable, Equatable, Sendable {
  public let text: String
  public let from: String?
  public let waiting: Bool?
  /// Which of the owner's messages it answers.
  public let said: String?
}

/// The chat as it stands.
public struct ChatShow: Decodable, Equatable, Sendable {
  public let conversation: String?
  /// The chat it shows, by id: the same as `conversation`, and named so by every chat call.
  public let chat: String?
  public let title: String
  public let messages: [ChatMessage]
  public let notice: ChatNotice?
  /// Whether this chat acts without asking each step.
  public let auto: Bool?
  /// The newest steps' pictures, base64 JPEG by frame id.
  public let pictures: [String: String]?
}

/// What a running turn waits on the owner for: a session asked on this Mac, or an approval.
public enum ChatWaiting: String, Decodable, Equatable, Sendable {
  case consent, approval
}

/// A turn as it goes: taken, its steps so far, done, or failed.
public struct ChatStatus: Decodable, Equatable, Sendable {
  public let conversation: String?
  /// The chat the turn is in, by id.
  public let chat: String?
  /// Which of the owner's messages the turn is for.
  public let said: String?
  public let taken: Bool?
  /// KOS took the words as a command, never in the chat's words.
  public let command: Bool?
  public let error: String?
  /// The turn's steps so far; `.some(nil)` when KOS said null, the turn done; nil when it said nothing of them.
  public let story: String??
  /// A step's picture, sent on its own as the step lands.
  public let frame: ChatFrame?
  /// The turn is held on the owner's answer.
  public let waiting: ChatWaiting?
  /// The owner took the Mac over, and the turn waits for it back.
  public let held: Bool?

  enum CodingKeys: String, CodingKey { case conversation, chat, said, taken, command, error, story, frame, waiting, held }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    conversation = try c.decodeIfPresent(String.self, forKey: .conversation)
    chat = try c.decodeIfPresent(String.self, forKey: .chat)
    said = try c.decodeIfPresent(String.self, forKey: .said)
    taken = try c.decodeIfPresent(Bool.self, forKey: .taken)
    command = try c.decodeIfPresent(Bool.self, forKey: .command)
    error = try c.decodeIfPresent(String.self, forKey: .error)
    story = c.contains(.story) ? .some(try c.decodeIfPresent(String.self, forKey: .story)) : nil
    frame = try c.decodeIfPresent(ChatFrame.self, forKey: .frame)
    // A wait this window does not know of is still a wait.
    waiting = try c.decodeIfPresent(String.self, forKey: .waiting).map { ChatWaiting(rawValue: $0) ?? .approval }
    held = try c.decodeIfPresent(Bool.self, forKey: .held)
  }

  /// The chat the turn is in, by either name.
  public var turnChat: String? { chat ?? conversation }
}

/// An approval to decide in the window: the tool, what it would be given, and why.
public struct ChatApproval: Decodable, Equatable, Sendable {
  public let id: String
  public let tool: String
  public let args: String?
  /// Every action a step said by its purpose takes, which the arguments, cut to fit, may not reach.
  public let mechanics: String?
  public let why: String?
  public let reason: String?
  /// What a remembered yes covers, as its button says it, when one may be.
  public let always: String?
  /// When it is decided for the owner if they do not, epoch milliseconds.
  public let expiresAt: Double?

  public init(
    id: String, tool: String, args: String? = nil, mechanics: String? = nil, why: String? = nil, reason: String? = nil, always: String? = nil,
    expiresAt: Double? = nil
  ) {
    self.id = id
    self.tool = tool
    self.args = args
    self.mechanics = mechanics
    self.why = why
    self.reason = reason
    self.always = always
    self.expiresAt = expiresAt
  }
}

public struct ChatAsk: Decodable, Equatable, Sendable {
  /// The chat it is asked in.
  public let chat: String?
  public let approval: ChatApproval
}

public struct ChatSettled: Decodable, Equatable, Sendable {
  public let approval: String
  public let outcome: String
}

public struct ChatItem: Decodable, Equatable, Sendable {
  public let id: String
  public let title: String
  /// Epoch milliseconds.
  public let updatedAt: Double
  /// Where the chat lives, when KOS says: at the root with KOS, in a project, or a blob's.
  public let place: ChatPlace?
}

/// Where a chat lives (docs/computer.md): `kos` at the root, `project` or `blob` by its name.
public struct ChatPlace: Decodable, Equatable, Sendable {
  public let kind: String
  public let name: String?
}

/// The chats the window may continue, newest first.
public struct ChatChats: Decodable, Equatable, Sendable {
  public let chats: [ChatItem]
  public let current: String?
}

/// Something an @ can name, as KOS's index answers it.
public struct ChatMention: Decodable, Equatable, Sendable {
  public let kind: String
  public let id: String
  public let label: String
  public let hint: String?
}

/// What an @ the owner is typing may name.
public struct ChatMentions: Decodable, Equatable, Sendable {
  public let q: String
  public let mentions: [ChatMention]
}

/// What answers: the model, the ones it may be changed to, or an engine that chooses its own.
public struct ChatModels: Decodable, Equatable, Sendable {
  public let current: String
  public let choices: [String]
  public let fixed: String?
  public let error: String?
}

/// Where the owner was when they spoke: the app in front of the window, one they hid, or none.
public enum Beside: Encodable, Equatable, Sendable {
  case app(name: String, bundle: String?, title: String?)
  case hidden
  case none

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    switch self {
    case .app(let name, let bundle, let title):
      try c.encode("app", forKey: .kind)
      try c.encode(name, forKey: .name)
      try c.encodeIfPresent(bundle, forKey: .bundle)
      try c.encodeIfPresent(title, forKey: .title)
    case .hidden:
      try c.encode("hidden", forKey: .kind)
    case .none:
      try c.encode("none", forKey: .kind)
    }
  }

  private enum Keys: String, CodingKey { case kind, name, bundle, title }
}

/// What the owner selected in the app in front, sent once with their words and kept with them: the words, and where
/// they are from.
public struct Quote: Codable, Equatable, Sendable {
  public let text: String
  public let from: String

  public init(text: String, from: String) {
    self.text = text
    self.from = from
  }
}

/// What the window tells KOS: it opened, the owner's words, a decision, and what to show next.
public enum ChatEvent: Sendable {
  case open
  case send(text: String, beside: Beside, quote: Quote? = nil)
  /// Stop the chat's turn, its sessions on this Mac and any ask for one.
  case stop
  /// What an @ may name, by the start of it.
  case mentions(String)
  case decide(approval: String, approved: Bool, remember: Bool)
  case list
  case switchTo(conversation: String)
  case models
  case model(String)
  case auto(Bool)
  /// What is running, failing and next across KOS, asked by a phone (docs/computer.md, Glance).
  case glance

  /// The event as a frame for the line.
  public func frame() throws -> Data {
    switch self {
    case .open: return try Outbound.chatEvent("chat.open", data: Empty())
    case .send(let text, let beside, let quote): return try Outbound.chatEvent("chat.send", data: Send(text: text, beside: beside, quote: quote))
    case .stop: return try Outbound.chatEvent("chat.stop", data: Empty())
    case .mentions(let q): return try Outbound.chatEvent("chat.mentions", data: Mentions(q: q))
    case .decide(let approval, let approved, let remember):
      return try Outbound.chatEvent("chat.decide", data: Decide(approval: approval, approved: approved, remember: remember ? true : nil))
    case .list: return try Outbound.chatEvent("chat.list", data: Empty())
    case .switchTo(let conversation): return try Outbound.chatEvent("chat.switch", data: Switch(conversation: conversation))
    case .models: return try Outbound.chatEvent("chat.models", data: Empty())
    case .model(let model): return try Outbound.chatEvent("chat.model", data: Model(model: model))
    case .auto(let on): return try Outbound.chatEvent("chat.auto", data: Auto(on: on))
    case .glance: return try Outbound.chatEvent("chat.glance", data: Empty())
    }
  }

  private struct Empty: Encodable {}
  private struct Send: Encodable {
    let text: String
    let beside: Beside
    let quote: Quote?
  }
  private struct Mentions: Encodable { let q: String }
  private struct Decide: Encodable {
    let approval: String
    let approved: Bool
    let remember: Bool?
  }
  private struct Switch: Encodable { let conversation: String }
  private struct Model: Encodable { let model: String }
  private struct Auto: Encodable { let on: Bool }
}
