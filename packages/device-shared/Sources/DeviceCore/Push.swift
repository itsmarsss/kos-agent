import Foundation

// Asks pushed to a phone whose app is not open (docs/computer.md, Push): the token it gives KOS for them, and what
// a notification KOS sent says.

/// Which of APNs' gateways a phone's token is good on: the sandbox for a build run from Xcode, production for
/// TestFlight and the App Store.
public enum PushEnvironment: String, Codable, Sendable {
  case sandbox, production

  /// From the app's `aps-environment`, as its build setting writes it into Info.plist; none, and this build has no push.
  public init?(apsEnvironment: String?) {
    switch apsEnvironment?.trimmingCharacters(in: .whitespaces) {
    case "development": self = .sandbox
    case "production": self = .production
    default: return nil
    }
  }
}

/// The token a phone gives KOS to push its asks to, sent as `push.token` each time it is on the line; with no token,
/// the phone took its notifications back and KOS forgets it.
public struct PushToken: Codable, Equatable, Sendable {
  public static let event = "push.token"

  public let token: String?
  public let env: PushEnvironment?

  public init(token: String, env: PushEnvironment) {
    self.token = token
    self.env = env
  }

  private init() {
    token = nil
    env = nil
  }

  /// Notifications off: KOS forgets the token it had.
  public static let off = PushToken()

  /// The token as APNs hands it to the app, in the hex KOS takes.
  public static func hex(_ deviceToken: Data) -> String {
    deviceToken.map { String(format: "%02x", $0) }.joined()
  }
}

/// What a notification from KOS is about: an ask to decide, or one settled elsewhere, to take down.
public enum PushNote: Equatable, Sendable {
  case ask(String)
  case settled(String)

  /// The notification category of an ask, with Approve and Deny; one too long to approve unseen has Deny alone.
  public static let askCategory = "kos.ask"
  public static let openCategory = "kos.ask.open"
  public static let approveAction = "kos.approve"
  public static let denyAction = "kos.deny"

  /// An ask's notification by its id on the phone: KOS sends it as the collapse id, which becomes the id.
  public static func identifier(ask: String) -> String { String("kos.ask.\(ask)".prefix(64)) }

  /// What KOS put under `kos` in the push: nil for a notification that is not KOS's, or an id that is not one.
  public init?(userInfo: [AnyHashable: Any]) {
    guard let kos = userInfo["kos"] as? [String: Any] else { return nil }
    if let id = kos["ask"] as? String, Self.isId(id) {
      self = .ask(id)
    } else if let id = kos["settled"] as? String, Self.isId(id) {
      self = .settled(id)
    } else {
      return nil
    }
  }

  /// An approval's id as KOS makes them: digits.
  private static func isId(_ id: String) -> Bool { !id.isEmpty && id.count <= 20 && id.allSatisfy(\.isASCII) && id.allSatisfy(\.isNumber) }
}
