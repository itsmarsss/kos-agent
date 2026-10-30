import Foundation

/// Why a session ended, as KOS is told it.
public enum EndReason: String, Codable, Sendable {
  case owner, expired, idle, quit, host
}

/// A session the owner allowed.
public struct LiveSession: Equatable, Sendable {
  public let id: String
  public let task: String
  public let requester: String
  /// The chat that asked, by id, when KOS said.
  public let conversation: String?
  public let until: Date
  public let space: Space
  public fileprivate(set) var paused = false
  public fileprivate(set) var lastActivity: Date
}

/// The one session this device may be in, and every rule about it.
///
/// One at a time; nothing acts without one live; the owner pauses it by
/// touching the computer and only the owner resumes it; it ends at its time
/// limit or after three idle minutes. The app holds one of these and asks
/// it before every action, so the rules are here and tested, not spread
/// through the windows.
public struct Sessions: Sendable {
  public enum Phase: Equatable, Sendable {
    case idle
    /// KOS asked and the owner has not answered yet.
    case asking(String)
    case live(LiveSession)
  }

  /// How long a live session may sit with no call before it ends: the owner's setting, three minutes unless changed.
  public var idleLimit: TimeInterval = 180

  /// How much one press of +15 gives, and the furthest a session may run from now.
  public static let extension_: TimeInterval = 15 * 60
  public static let furthest: TimeInterval = 8 * 60 * 60

  public private(set) var phase: Phase = .idle

  public init() {}

  public var live: LiveSession? {
    if case .live(let session) = phase { return session }
    return nil
  }

  public mutating func ask(_ id: String) throws {
    guard phase == .idle else { throw DeviceError(.busy, "Another session is live on this Mac.") }
    guard !id.isEmpty else { throw DeviceError.badRequest("The session needs an id.") }
    phase = .asking(id)
  }

  public mutating func grant(
    _ id: String, task: String, requester: String, conversation: String? = nil, minutes: Int, space: Space, now: Date
  ) throws -> LiveSession {
    guard phase == .asking(id) else { throw DeviceError(.noSession, "Nothing was asked for under that id.") }
    let session = LiveSession(
      id: id, task: task, requester: requester, conversation: conversation, until: now.addingTimeInterval(TimeInterval(minutes * 60)),
      space: space, lastActivity: now)
    phase = .live(session)
    return session
  }

  public mutating func deny(_ id: String) {
    if phase == .asking(id) { phase = .idle }
  }

  /// A call under `id`, checked against the live session and counted as activity.
  public mutating func authorize(_ id: String, now: Date) throws -> LiveSession {
    guard case .live(var session) = phase, session.id == id else {
      throw DeviceError(.noSession, "No live session with that id.")
    }
    if due(now) != nil { throw DeviceError(.noSession, "The session is over.") }
    if session.paused { throw DeviceError(.paused, "The owner took over. Wait for them to resume it on this Mac.") }
    session.lastActivity = now
    phase = .live(session)
    return session
  }

  /// The owner took over. The session's id when this paused it, nothing when it was not running.
  public mutating func pause() -> String? {
    guard case .live(var session) = phase, !session.paused else { return nil }
    session.paused = true
    phase = .live(session)
    return session.id
  }

  /// The owner gave it back. Idle time starts again from now.
  public mutating func resume(now: Date) -> String? {
    guard case .live(var session) = phase, session.paused else { return nil }
    session.paused = false
    session.lastActivity = now
    phase = .live(session)
    return session.id
  }

  /// Ends whatever is live or being asked for; the id it ended.
  @discardableResult
  public mutating func end() -> String? {
    defer { phase = .idle }
    switch phase {
    case .idle: return nil
    case .asking(let id): return id
    case .live(let session): return session.id
    }
  }

  /// Why the live session should end now, if it should.
  public func due(_ now: Date) -> EndReason? {
    guard let session = live else { return nil }
    if now >= session.until { return .expired }
    if now.timeIntervalSince(session.lastActivity) >= idleLimit { return .idle }
    return nil
  }

  /// The owner gave the live session more time: its new end, or nothing when none is live.
  public mutating func extend(now: Date) -> Date? {
    guard case .live(let session) = phase else { return nil }
    let until = min(session.until.addingTimeInterval(Self.extension_), now.addingTimeInterval(Self.furthest))
    phase = .live(LiveSession(
      id: session.id, task: session.task, requester: session.requester, conversation: session.conversation,
      until: until, space: session.space, paused: session.paused, lastActivity: now))
    return until
  }
}

/// How long the owner may allow a session for, under the longest they set on this Mac.
public enum Durations {
  public static let choices = [5, 15, 30, 60, 120, 240, 480]
  /// What the owner may set as the longest session.
  public static let longestChoices = [15, 30, 60, 120, 240, 480]
  public static let defaultLongest = 60

  /// The choices up to what KOS asked for, with what it asked for itself as the longest, never past `longest`.
  public static func offered(requested: Double, longest: Int = defaultLongest) -> [Int] {
    let asked = capped(requested, longest: longest)
    return choices.filter { $0 < asked } + [asked]
  }

  /// What a session gets when the owner chose to let KOS's approval queue decide.
  public static func unattended(requested: Double, longest: Int = defaultLongest) -> Int {
    capped(requested, longest: longest)
  }

  public static func validate(_ minutes: Double) throws {
    guard minutes.isFinite, minutes > 0 else { throw DeviceError.badRequest("minutes must be more than zero.") }
  }

  /// Whole minutes, at least one and at most `longest`.
  private static func capped(_ minutes: Double, longest: Int) -> Int {
    guard minutes.isFinite, minutes > 0 else { return 1 }
    return Int(min(Double(max(1, longest)), minutes).rounded(.up))
  }
}
