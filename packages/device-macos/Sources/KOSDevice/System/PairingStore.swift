import DeviceCore
import Foundation
import Security

/// The pairings, in the Keychain: readable by this app only, on this Mac only, once it has been unlocked.
///
/// One item holds the list. An app from before there could be several kept
/// its one pairing under another account; it is moved into the list the
/// first time it is read.
enum PairingStore {
  private static let service = "KOS Device"
  private static let account = "pairings"
  /// Where the one pairing lived before a device could pair with several KOS.
  private static let legacyAccount = "pairing"

  private static func query(_ account: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
  }

  /// The saved pairings, none when none were saved. A Keychain that will not
  /// give them up throws: read as "not paired", it had the owner pair again
  /// when allowing KOS Device in the Keychain was all it needed.
  static func load() throws -> [Pairing] {
    if let data = try read(account) {
      do {
        let list = try JSONDecoder().decode([Pairing].self, from: data)
        Log.pairing.notice("read \(list.count, privacy: .public) pairing(s): \(list.map(\.kos).joined(separator: ", "), privacy: .public)")
        return list
      } catch {
        Log.pairing.error("the saved pairings did not decode: \(error.localizedDescription, privacy: .public)")
        throw DeviceError(.internal, "The saved pairings could not be read. Pair again.")
      }
    }
    guard let data = try read(legacyAccount) else {
      Log.pairing.notice("no pairings saved")
      return []
    }
    guard let one = try? JSONDecoder().decode(Pairing.self, from: data) else {
      Log.pairing.error("the saved pairing from an older version did not decode")
      throw DeviceError(.internal, "The saved pairing could not be read. Pair again.")
    }
    do {
      try save([one])
      SecItemDelete(query(legacyAccount) as CFDictionary)
      Log.pairing.notice("moved the one pairing, \(one.kos, privacy: .public), into the list")
    } catch {
      // Kept where it was, so the next start tries again; this one carries on with it.
      Log.pairing.error("could not move the one pairing into the list: \(error.localizedDescription, privacy: .public)")
    }
    return [one]
  }

  static func save(_ list: [Pairing]) throws {
    SecItemDelete(query(account) as CFDictionary)
    guard !list.isEmpty else {
      Log.pairing.notice("no pairings left")
      return
    }
    var item = query(account)
    item[kSecValueData as String] = try JSONEncoder().encode(list)
    item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    item[kSecAttrLabel as String] = "KOS Device pairings"
    let status = SecItemAdd(item as CFDictionary, nil)
    guard status == errSecSuccess else {
      Log.pairing.error("the Keychain would not keep the pairings: \(status, privacy: .public) \(describe(status), privacy: .public)")
      throw DeviceError(.internal, "Could not keep the pairing in the Keychain: \(describe(status))")
    }
    Log.pairing.notice("kept \(list.count, privacy: .public) pairing(s)")
  }

  /// The item's data, nothing when there is no such item; throws when the Keychain refuses.
  private static func read(_ account: String) throws -> Data? {
    var lookup = query(account)
    lookup[kSecReturnData as String] = true
    lookup[kSecMatchLimit as String] = kSecMatchLimitOne
    var found: CFTypeRef?
    let status = SecItemCopyMatching(lookup as CFDictionary, &found)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = found as? Data else {
      Log.pairing.error("the Keychain refused \(account, privacy: .public): \(status, privacy: .public) \(describe(status), privacy: .public)")
      throw DeviceError(.internal, "The Keychain would not give KOS Device its pairings (\(describe(status))).")
    }
    return data
  }

  private static func describe(_ status: OSStatus) -> String {
    SecCopyErrorMessageString(status, nil) as String? ?? "status \(status)"
  }
}
