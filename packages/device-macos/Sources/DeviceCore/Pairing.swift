import Foundation

/// What pairing with one KOS left this device with: who it is to that KOS,
/// where the KOS is, and the KOS's pinned key.
public struct Pairing: Codable, Equatable, Sendable {
  /// This device's id in that KOS, and the pairing's own.
  public let deviceId: String
  public let address: String
  public let hostKey: String
  /// The device's Ed25519 private key for this KOS, raw.
  public let deviceKey: Data
  /// What this Mac is called in that KOS.
  public let name: String

  public init(deviceId: String, address: String, hostKey: String, deviceKey: Data, name: String) {
    self.deviceId = deviceId
    self.address = address
    self.hostKey = hostKey
    self.deviceKey = deviceKey
    self.name = name
  }

  public func kosAddress() throws -> KOSAddress { try KOSAddress(address) }
  public func signingKey() throws -> DeviceKey { try DeviceKey(raw: deviceKey) }
  public func pinnedHostKey() throws -> HostKey { try HostKey(base64: hostKey) }

  /// The KOS this pairs with, as one address however it was typed.
  public var kos: String { (try? kosAddress().base.absoluteString) ?? address }
}

/// The KOS this device is paired with, in the order they were paired.
///
/// A device may be paired with several, say one at home and one at work;
/// each is its own line, its own keys and its own trust. Pairing again with
/// a KOS already here replaces that pairing rather than adding a second line
/// to the same KOS.
public enum Pairings {
  public static func adding(_ new: Pairing, to list: [Pairing]) -> [Pairing] {
    let old = replaced(by: new, in: list).map(\.deviceId)
    guard let at = list.firstIndex(where: { old.contains($0.deviceId) }) else { return list + [new] }
    var next = list
    next[at] = new
    // Two old pairings matching it, one by address and one by id, leave one line, not two.
    return next.enumerated().filter { $0.offset == at || !old.contains($0.element.deviceId) }.map(\.element)
  }

  /// The pairings `new` takes the place of: the same KOS, or the same device id.
  public static func replaced(by new: Pairing, in list: [Pairing]) -> [Pairing] {
    list.filter { $0.kos == new.kos || $0.deviceId == new.deviceId }
  }

  public static func removing(_ deviceId: String, from list: [Pairing]) -> [Pairing] {
    list.filter { $0.deviceId != deviceId }
  }
}
