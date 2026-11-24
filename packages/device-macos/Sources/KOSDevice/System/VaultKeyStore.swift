@preconcurrency import CryptoKit
import DeviceCore
import Foundation
import Security

/// The key in the Secure Enclave a device slot is sealed to: ECDH is done there, the private half never leaves it.
struct EnclaveVaultKey: VaultKey {
  let key: SecureEnclave.P256.KeyAgreement.PrivateKey

  var point: Data { key.publicKey.x963Representation }
  var store: String { "enclave" }

  func sharedSecret(with peer: P256.KeyAgreement.PublicKey) throws -> SharedSecret {
    try key.sharedSecretFromKeyAgreement(with: peer)
  }
}

/// This Mac's vault key (docs/secrets.md, Device slots), made the first time KOS asks for it.
///
/// In the Secure Enclave, usable once the Mac has been unlocked since it started, on this Mac only: what is kept is
/// the enclave's handle to it, which opens nothing anywhere else. A Mac without an enclave keeps a software key
/// instead. Either is kept in the Keychain beside the pairings: the data protection keychain where this build may
/// use it, else the login keychain, where a reinstall asks the owner to allow KOS for Mac again, as the pairings do.
/// Nothing here runs in tests: VaultUnwrapTests stand in a SoftwareVaultKey.
enum VaultKeyStore {
  private static let service = "KOS Device"
  private static let account = "vault-key"

  private struct Kept: Codable {
    let store: String
    let data: Data
  }

  /// The key, made and kept the first time.
  static func key() throws -> VaultKey {
    if let kept = try read() { return try open(kept) }
    let made: Kept
    if SecureEnclave.isAvailable {
      var problem: Unmanaged<CFError>?
      guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, .privateKeyUsage, &problem) else {
        throw DeviceError(.internal, "The Secure Enclave key's access could not be set: \(problem?.takeRetainedValue().localizedDescription ?? "unknown").")
      }
      made = Kept(store: "enclave", data: try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: access).dataRepresentation)
    } else {
      made = Kept(store: "software", data: P256.KeyAgreement.PrivateKey().rawRepresentation)
    }
    try save(made)
    Log.app.notice("made a vault key (\(made.store, privacy: .public))")
    return try open(made)
  }

  private static func open(_ kept: Kept) throws -> VaultKey {
    do {
      switch kept.store {
      case "enclave": return EnclaveVaultKey(key: try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: kept.data))
      default: return SoftwareVaultKey(try P256.KeyAgreement.PrivateKey(rawRepresentation: kept.data))
      }
    } catch {
      throw DeviceError(.internal, "This Mac's vault key does not open: \(error.localizedDescription)")
    }
  }

  private static func query(protected: Bool) -> [String: Any] {
    var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    if protected { q[kSecUseDataProtectionKeychain as String] = true }
    return q
  }

  private static func read() throws -> Kept? {
    for protected in [true, false] {
      var lookup = query(protected: protected)
      lookup[kSecReturnData as String] = true
      lookup[kSecMatchLimit as String] = kSecMatchLimitOne
      var found: CFTypeRef?
      let status = SecItemCopyMatching(lookup as CFDictionary, &found)
      if status == errSecItemNotFound || status == errSecMissingEntitlement { continue }
      guard status == errSecSuccess, let data = found as? Data else {
        throw DeviceError(.internal, "The Keychain would not give KOS for Mac its vault key (\(describe(status))).")
      }
      return try JSONDecoder().decode(Kept.self, from: data)
    }
    return nil
  }

  private static func save(_ kept: Kept) throws {
    let data = try JSONEncoder().encode(kept)
    var status = errSecMissingEntitlement
    for protected in [true, false] where status == errSecMissingEntitlement {
      var item = query(protected: protected)
      item[kSecValueData as String] = data
      item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      item[kSecAttrLabel as String] = "KOS Device vault key"
      status = SecItemAdd(item as CFDictionary, nil)
    }
    guard status == errSecSuccess else {
      throw DeviceError(.internal, "Could not keep the vault key in the Keychain: \(describe(status))")
    }
  }

  private static func describe(_ status: OSStatus) -> String {
    SecCopyErrorMessageString(status, nil) as String? ?? "status \(status)"
  }
}
