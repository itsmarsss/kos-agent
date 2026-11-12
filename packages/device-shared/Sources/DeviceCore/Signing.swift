@preconcurrency import CryptoKit
import Foundation

/// The two sentences each side signs in the handshake. Byte for byte what
/// KOS builds, so they live in one place and are tested against KOS's own
/// signature.
public enum Handshake {
  public static func devicePayload(hostNonce: String, deviceId: String) -> Data {
    Data("kos-device/\(protocolVersion)|device|\(hostNonce)|\(deviceId)".utf8)
  }

  public static func hostPayload(deviceNonce: String, deviceId: String) -> Data {
    Data("kos-device/\(protocolVersion)|host|\(deviceNonce)|\(deviceId)".utf8)
  }

  /// A fresh nonce: 32 random bytes, as base64 text.
  public static func makeNonce() -> String {
    var generator = SystemRandomNumberGenerator()
    let bytes = (0..<32).map { _ in UInt8.random(in: .min ... .max, using: &generator) }
    return Data(bytes).base64EncodedString()
  }

  /// A nonce KOS sent is 32 bytes of base64; anything else is a malformed challenge.
  public static func isValidNonce(_ nonce: String) -> Bool {
    Data(base64Encoded: nonce)?.count == 32
  }
}

/// This device's identity: an Ed25519 key made at pairing, kept in the Keychain.
public struct DeviceKey: Sendable {
  private let key: Curve25519.Signing.PrivateKey

  public init() {
    key = Curve25519.Signing.PrivateKey()
  }

  public init(raw: Data) throws {
    key = try Curve25519.Signing.PrivateKey(rawRepresentation: raw)
  }

  public var rawRepresentation: Data { key.rawRepresentation }

  public var publicKeyBase64: String { key.publicKey.rawRepresentation.base64EncodedString() }

  public func sign(_ payload: Data) throws -> String {
    try key.signature(for: payload).base64EncodedString()
  }
}

/// KOS's public key, pinned at pairing. A host that cannot sign with it is not KOS.
public struct HostKey: Equatable, Sendable {
  private let key: Curve25519.Signing.PublicKey
  public let base64: String

  public init(base64: String) throws {
    guard let raw = Data(base64Encoded: base64), raw.count == 32 else {
      throw DeviceError.badRequest("KOS's key is not a 32-byte Ed25519 key.")
    }
    key = try Curve25519.Signing.PublicKey(rawRepresentation: raw)
    self.base64 = base64
  }

  public func verify(signature: String, payload: Data) -> Bool {
    guard let sig = Data(base64Encoded: signature) else { return false }
    return key.isValidSignature(sig, for: payload)
  }

  public static func == (lhs: HostKey, rhs: HostKey) -> Bool {
    lhs.base64 == rhs.base64
  }
}
