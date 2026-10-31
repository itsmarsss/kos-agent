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

  /// The saved pairing, or nothing when none was saved. A Keychain that will
  /// not give it up throws: read as "not paired", it had the owner pair again
  /// when allowing KOS Device in the Keychain was all it needed.
  static func load() throws -> Pairing? {
    var lookup = query
    lookup[kSecReturnData as String] = true
    lookup[kSecMatchLimit as String] = kSecMatchLimitOne
    var found: CFTypeRef?
    let status = SecItemCopyMatching(lookup as CFDictionary, &found)
    if status == errSecItemNotFound {
      Log.pairing.notice("no pairing saved")
      return nil
    }
    guard status == errSecSuccess, let data = found as? Data else {
      Log.pairing.error("the Keychain refused the pairing: \(status, privacy: .public) \(describe(status), privacy: .public)")
      throw DeviceError(.internal, "The Keychain would not give KOS Device its pairing (\(describe(status))).")
    }
    do {
      let pairing = try JSONDecoder().decode(Pairing.self, from: data)
      Log.pairing.notice("pairing read for \(pairing.address, privacy: .public)")
      return pairing
    } catch {
      Log.pairing.error("the saved pairing did not decode: \(error.localizedDescription, privacy: .public)")
      throw DeviceError(.internal, "The saved pairing could not be read. Pair again.")
    }
  }

  private static func describe(_ status: OSStatus) -> String {
    SecCopyErrorMessageString(status, nil) as String? ?? "status \(status)"
  }

  static func save(_ pairing: Pairing) throws {
    clear()
    var item = query
    item[kSecValueData as String] = try JSONEncoder().encode(pairing)
    item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    item[kSecAttrLabel as String] = "KOS Device pairing"
    let status = SecItemAdd(item as CFDictionary, nil)
    guard status == errSecSuccess else {
      Log.pairing.error("the Keychain would not keep the pairing: \(status, privacy: .public) \(describe(status), privacy: .public)")
      throw DeviceError(.internal, "Could not keep the pairing in the Keychain: \(describe(status))")
    }
    Log.pairing.notice("pairing kept for \(pairing.address, privacy: .public)")
  }

  static func clear() {
    let status = SecItemDelete(query as CFDictionary)
    Log.pairing.notice("pairing cleared: \(status == errSecSuccess ? "removed" : describe(status), privacy: .public)")
  }
}
