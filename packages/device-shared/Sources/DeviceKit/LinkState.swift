import Foundation

/// Where the line to one KOS stands.
public enum LinkState: Equatable {
  case connecting
  case connected
  case offline(String)
  /// The far end could not sign with the key pinned at pairing.
  case untrusted
  /// Another copy of KOS for Mac took the line.
  case replaced
  case outdated
  /// The owner disconnected on purpose.
  case disconnected
}

extension BlobMood {
  /// How KOS looks on a line, for both windows: sagging when it cannot be reached, asleep only when the owner disconnected it.
  public init(link: LinkState?) {
    switch link {
    case .offline, .untrusted, .outdated: self = .error
    case .disconnected: self = .asleep
    default: self = .idle
    }
  }
}
