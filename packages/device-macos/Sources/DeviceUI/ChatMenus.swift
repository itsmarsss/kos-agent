import Foundation

/// The box's / and @ menus, as the side panel offers them (packages/browser-extension panel.tsx):
/// the chat's commands by the start of their names, and what an @ may name as KOS's index answers it.
public enum ChatMenus {
  /// One line of a menu: what goes in the box in place of what was typed, how it reads, and a word about it.
  public struct Option: Equatable, Sendable {
    public let insert: String
    public let label: String
    public let hint: String?
  }

  /// Something an @ can name, as KOS's index answers it.
  public struct Mention: Equatable, Sendable {
    public let kind: String
    public let id: String
    public let label: String
    public let hint: String?

    public init(kind: String, id: String, label: String, hint: String? = nil) {
      self.kind = kind
      self.id = id
      self.label = label
      self.hint = hint
    }
  }

  /// What is being typed at the end of the box: a command at its start, or an @ after a space.
  public struct Token: Equatable, Sendable {
    public enum Kind: Sendable { case command, mention }
    public let kind: Kind
    public let q: String
    /// Where it starts in the box, in characters.
    public let start: Int
    public let raw: String
  }

  /// The commands a chat beside the owner's apps can run, as packages/shared commands.ts lists them; the dashboard's own left out.
  static let commands: [(name: String, args: String?, description: String)] = [
    ("new", "[title]", "start another chat"),
    ("chats", nil, "list your chats"),
    ("switch", "<number|title>", "move to one"),
    ("rename", "<title>", "rename this chat"),
    ("fork", "[title]", "copy this chat, history and all, and move to the copy"),
    ("archive", nil, "close this chat"),
    ("retry", nil, "ask the last message again"),
    ("stop", nil, "stop the turn running here"),
    ("brief", "[text]", "show or set this chat's standing instructions"),
    ("agent", "[title]", "start an agent in this project and move to it"),
    ("agents", nil, "list this project's agents and what they are doing"),
    ("dispatch", "<agent>: <task>", "hand a task to an agent"),
    ("project", "<name>", "stand up a project with its orchestrator"),
    ("approve", "[#]", "approve what this chat is waiting on"),
    ("deny", "[#]", "deny it"),
    ("status", nil, "what is running, and what is waiting on you"),
    ("compact", nil, "replace this chat's history with a summary of it"),
    ("clear", nil, "forget this chat's history, keep the chat"),
    ("tools", nil, "choose which tools this chat may use"),
    ("help", nil, "show these commands"),
  ]

  /// The token being typed at the end of `text`.
  public static func token(in text: String) -> Token? {
    if text.hasPrefix("/"), text.dropFirst().allSatisfy({ $0.isASCII && $0.isLowercase }) {
      return Token(kind: .command, q: String(text.dropFirst()), start: 0, raw: text)
    }
    guard let at = text.lastIndex(of: "@") else { return nil }
    let q = text[text.index(after: at)...]
    guard !q.contains(where: \.isWhitespace) else { return nil }
    guard at == text.startIndex || text[text.index(before: at)].isWhitespace else { return nil }
    let start = text.distance(from: text.startIndex, to: at)
    return Token(kind: .mention, q: String(q), start: start, raw: "@\(q)")
  }

  /// The commands whose names start with `q`, eight at most.
  public static func commands(_ q: String) -> [Option] {
    commands.filter { $0.name.hasPrefix(q) }.prefix(8).map { c in
      Option(insert: "/\(c.name) ", label: "/\(c.name)\(c.args.map { " \($0)" } ?? "")", hint: c.description)
    }
  }

  /// A thing to name, written as the dashboard writes it: plain when its id allows, in brackets when not.
  public static func option(_ mention: Mention) -> Option {
    let plain = mention.id.range(of: #"^[A-Za-z0-9._/-]*[A-Za-z0-9_/-]$"#, options: .regularExpression) != nil
    let insert = mention.kind == "channel" ? "#\(mention.id) " : plain ? "@\(mention.kind):\(mention.id) " : "@\(mention.kind):[\(mention.id)] "
    return Option(insert: insert, label: mention.label, hint: mention.hint ?? mention.kind)
  }

  /// `text` with the token typed at its end in place of `option`.
  public static func take(_ option: Option, for token: Token, in text: String) -> String {
    String(text.prefix(token.start)) + option.insert
  }
}
