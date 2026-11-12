import Foundation

/// What is going on across a KOS, as it answers a phone's `chat.glance`
/// (docs/computer.md, A phone): the chats at work, what waits on the owner,
/// the jobs failing, and the schedules due next. Times are epoch milliseconds.
public struct Glance: Decodable, Equatable, Sendable {
  public struct Running: Decodable, Equatable, Sendable {
    public let id: String
    public let title: String

    public init(id: String, title: String) {
      self.id = id
      self.title = title
    }
  }

  public struct Failing: Decodable, Equatable, Sendable {
    public let label: String
    /// How many runs in a row have failed.
    public let streak: Int
    public let error: String?
    public let since: Double

    public init(label: String, streak: Int, error: String? = nil, since: Double) {
      self.label = label
      self.streak = streak
      self.error = error
      self.since = since
    }
  }

  public struct Next: Decodable, Equatable, Sendable {
    public let name: String
    public let at: Double

    public init(name: String, at: Double) {
      self.name = name
      self.at = at
    }
  }

  /// KOS's kill switch is thrown: nothing runs until it is let go.
  public let halted: Bool
  public let running: [Running]
  /// Every approval waiting on the owner, in any chat.
  public let waiting: Int
  public let failing: [Failing]
  public let next: [Next]

  public init(halted: Bool = false, running: [Running] = [], waiting: Int = 0, failing: [Failing] = [], next: [Next] = []) {
    self.halted = halted
    self.running = running
    self.waiting = waiting
    self.failing = failing
    self.next = next
  }

  /// The method KOS calls with it.
  public static let method = "chat.glance"

  enum CodingKeys: String, CodingKey { case halted, running, waiting, failing, next }

  // Read leniently: a list KOS leaves out is empty, so a newer KOS that drops one still reads.
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    halted = try c.decodeIfPresent(Bool.self, forKey: .halted) ?? false
    running = try c.decodeIfPresent([Running].self, forKey: .running) ?? []
    waiting = try c.decodeIfPresent(Int.self, forKey: .waiting) ?? 0
    failing = try c.decodeIfPresent([Failing].self, forKey: .failing) ?? []
    next = try c.decodeIfPresent([Next].self, forKey: .next) ?? []
  }
}
