import DeviceCore
import Foundation
import Security

/// What pairing left this device with: who it is to KOS, where KOS is, and KOS's pinned key.
struct Pairing: Codable, Equatable {
  let deviceId: String
  let address: String
  let hostKey: String
  /// The device's Ed25519 private key, raw.
  let deviceKey: Data
  let name: String

  func kosAddress() throws -> KOSAddress { try KOSAddress(address) }
  func signingKey() throws -> DeviceKey { try DeviceKey(raw: deviceKey) }
  func pinnedHostKey() throws -> HostKey { try HostKey(base64: hostKey) }
}

/// The pairing, in the Keychain: readable by this app only, on this Mac only, once it has been unlocked.
enum PairingStore {
  private static let service = "KOS Device"
  private static let account = "pairing"

  private static var query: [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
  }

  static func load() -> Pairing? {
    var lookup = query
    lookup[kSecReturnData as String] = true
    lookup[kSecMatchLimit as String] = kSecMatchLimitOne
    var found: CFTypeRef?
    guard SecItemCopyMatching(lookup as CFDictionary, &found) == errSecSuccess, let data = found as? Data else { return nil }
    return try? JSONDecoder().decode(Pairing.self, from: data)
  }

  static func save(_ pairing: Pairing) throws {
    clear()
    var item = query
    item[kSecValueData as String] = try JSONEncoder().encode(pairing)
    item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    item[kSecAttrLabel as String] = "KOS Device pairing"
    let status = SecItemAdd(item as CFDictionary, nil)
    guard status == errSecSuccess else {
      let reason = SecCopyErrorMessageString(status, nil) as String? ?? "status \(status)"
      throw DeviceError(.internal, "Could not keep the pairing in the Keychain: \(reason)")
    }
  }

  static func clear() {
    SecItemDelete(query as CFDictionary)
  }
}
