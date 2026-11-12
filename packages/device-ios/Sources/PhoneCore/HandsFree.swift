import Foundation

/// What a link opened on the phone asks for: to pair with a KOS, or to start
/// listening. Every `kos-device` link is one or the other; listening pairs
/// nothing and sends nothing, so it needs none of a pairing link's asking.
public enum PhoneLink: Equatable, Sendable {
  /// `kos-device://pair?...`, for PairingFlow to confirm.
  case pair(URL)
  /// `kos-device://listen`: Ask KOS, from Shortcuts, Siri, the Action button or another app.
  case listen

  public static let scheme = "kos-device"
  /// The link that opens the app listening.
  public static let listenURL = URL(string: "kos-device://listen")!

  public init?(_ url: URL) {
    guard url.scheme?.lowercased() == Self.scheme else { return nil }
    switch url.host?.lowercased() {
    case "pair": self = .pair(url)
    // Nothing rides with a listen: words are the owner's to say, never a link's to put in their mouth.
    case "listen" where (url.query ?? "").isEmpty && (url.path.isEmpty || url.path == "/"): self = .listen
    default: return nil
    }
  }
}

/// Asks to listen that come from outside the app's screens (the Ask KOS
/// intent, which runs in the app's process), for the scene to hear and the
/// phone to act on.
@MainActor
public final class HandsFree: ObservableObject {
  public static let shared = HandsFree()

  /// How many times listening has been asked for; the scene listens on each change.
  @Published public private(set) var asked = 0

  public init() {}

  public func ask() {
    asked += 1
  }
}
