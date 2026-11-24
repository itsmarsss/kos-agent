@preconcurrency import CryptoKit
import Foundation

/// The key KOS for Mac keeps for the owner's vault (docs/secrets.md, Device slots): a P-256 key whose private half
/// stays where it was made, the Secure Enclave on a Mac that has one. A device slot in the vault is its data key
/// sealed to this key's point; only this Mac can make the key that opens it.
public protocol VaultKey: Sendable {
  /// The point, uncompressed (65 bytes): what a device slot is sealed to.
  var point: Data { get }
  /// Where the private half lives, as KOS is told: `enclave`, or `software` on a Mac without one.
  var store: String { get }
  /// ECDH with `peer`, done where the private half lives.
  func sharedSecret(with peer: P256.KeyAgreement.PublicKey) throws -> SharedSecret
}

/// A vault key held in memory: for a Mac without a Secure Enclave, and for tests, where nothing reaches the Keychain.
public struct SoftwareVaultKey: VaultKey {
  public let key: P256.KeyAgreement.PrivateKey

  public init(_ key: P256.KeyAgreement.PrivateKey = P256.KeyAgreement.PrivateKey()) {
    self.key = key
  }

  public var point: Data { key.publicKey.x963Representation }
  public var store: String { "software" }

  public func sharedSecret(with peer: P256.KeyAgreement.PublicKey) throws -> SharedSecret {
    try key.sharedSecretFromKeyAgreement(with: peer)
  }
}

/// vault.key's answer: the point, base64, and where its private half lives.
public struct VaultKeyResult: Encodable, Equatable, Sendable {
  public let key: String
  public let store: String

  public init(_ key: VaultKey) {
    self.key = key.point.base64EncodedString()
    self.store = key.store
  }
}

/// vault.unwrap's params: the vault and slot, the slot's point and ephemeral point, and the host's ephemeral point
/// the answer is sealed to.
public struct VaultUnwrapParams: Decodable, Sendable {
  public let vault: String
  public let slot: String
  public let key: String
  public let epk: String
  public let hostEpk: String

  public init(vault: String, slot: String, key: String, epk: String, hostEpk: String) {
    self.vault = vault
    self.slot = slot
    self.key = key
    self.epk = epk
    self.hostEpk = hostEpk
  }
}

/// vault.unwrap's answer: the slot's key sealed to the host's ephemeral point, with this side's ephemeral point.
public struct VaultUnwrapResult: Encodable, Equatable, Sendable {
  public let epk: String
  public let nonce: String
  public let ct: String
}

/// KOS for Mac's side of `vault.unwrap`, as the host's vaultkeys.ts specifies it and its known-answer vectors fix it.
public enum VaultUnwrap {
  /// The answer to `params` with `key`: the slot's key made by ECDH with its ephemeral point and HKDF-SHA256 (salt
  /// the ephemeral point then this key's, info `kos-vault/2 device|<vault>|<slot>`), then sealed with AES-256-GCM
  /// under HKDF of ECDH between a fresh point of this side's and the host's (info `kos-vault/2 unwrap|<vault>|<slot>`).
  /// `ephemeral` and `nonce` are for the vectors.
  public static func answer(
    _ params: VaultUnwrapParams,
    key: VaultKey,
    ephemeral: P256.KeyAgreement.PrivateKey = P256.KeyAgreement.PrivateKey(),
    nonce: AES.GCM.Nonce = AES.GCM.Nonce()
  ) throws -> VaultUnwrapResult {
    guard params.key == key.point.base64EncodedString() else {
      throw DeviceError(.key, "This Mac holds another vault key: the slot was made for another Mac, or this Mac's key was made again.")
    }
    let slotPoint = try point(params.epk, "epk")
    let hostPoint = try point(params.hostEpk, "hostEpk")
    let slotKey = try key.sharedSecret(with: slotPoint).hkdfDerivedSymmetricKey(
      using: SHA256.self, salt: slotPoint.x963Representation + key.point,
      sharedInfo: Data("kos-vault/2 device|\(params.vault)|\(params.slot)".utf8), outputByteCount: 32)
    let sealing = try ephemeral.sharedSecretFromKeyAgreement(with: hostPoint).hkdfDerivedSymmetricKey(
      using: SHA256.self, salt: ephemeral.publicKey.x963Representation + hostPoint.x963Representation,
      sharedInfo: Data("kos-vault/2 unwrap|\(params.vault)|\(params.slot)".utf8), outputByteCount: 32)
    let box = try slotKey.withUnsafeBytes { bytes in
      try AES.GCM.seal(Data(bytes), using: sealing, nonce: nonce, authenticating: Data("kos-vault/2|unwrap|\(params.vault)|\(params.slot)".utf8))
    }
    return VaultUnwrapResult(
      epk: ephemeral.publicKey.x963Representation.base64EncodedString(),
      nonce: Data(nonce).base64EncodedString(),
      ct: (box.ciphertext + box.tag).base64EncodedString())
  }

  private static func point(_ text: String, _ name: String) throws -> P256.KeyAgreement.PublicKey {
    guard let data = Data(base64Encoded: text), data.count == 65, let point = try? P256.KeyAgreement.PublicKey(x963Representation: data) else {
      throw DeviceError.badRequest("vault.unwrap: \(name) is not an uncompressed P-256 point.")
    }
    return point
  }
}
