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

  public static let idleLimit: TimeInterval = 180

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
    if now.timeIntervalSince(session.lastActivity) >= Self.idleLimit { return .idle }
    return nil
  }
}

/// How long the owner may allow a session for.
public enum Durations {
  public static let choices = [5, 15, 30, 60]
  public static let longest = 60

  /// The choices up to what KOS asked for, with what it asked for itself as the longest.
  public static func offered(requested: Double) -> [Int] {
    let asked = capped(requested)
    return choices.filter { $0 < asked } + [asked]
  }

  /// What a session gets when the owner chose to let KOS's approval queue decide.
  public static func unattended(requested: Double) -> Int {
    capped(requested)
  }

  public static func validate(_ minutes: Double) throws {
    guard minutes.isFinite, minutes > 0 else { throw DeviceError.badRequest("minutes must be more than zero.") }
  }

  /// Whole minutes, at least one and at most an hour.
  private static func capped(_ minutes: Double) -> Int {
    guard minutes.isFinite, minutes > 0 else { return 1 }
    return Int(min(Double(longest), minutes).rounded(.up))
  }
}
