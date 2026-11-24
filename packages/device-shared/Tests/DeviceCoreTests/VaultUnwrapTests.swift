@preconcurrency import CryptoKit
import Foundation
import Testing

@testable import DeviceCore

/// The host's known-answer vectors (vault.test.ts, docs/secrets.md): the device's scalar 0x01..0x20, the slot's
/// ephemeral 0x21..0x40, the host's 0x41..0x60, this side's 0x61..0x80, the answer's nonce 0xa0..0xab.
private func bytes(_ start: UInt8, _ count: Int) -> Data { Data((0..<count).map { start &+ UInt8($0) }) }
private func scalar(_ start: UInt8) throws -> P256.KeyAgreement.PrivateKey { try P256.KeyAgreement.PrivateKey(rawRepresentation: bytes(start, 32)) }

private let vault = "v_0123456789abcdef"
private let devicePoint = "BFFcPW6545a5BNP+yn9U/c0MwemXvzddylFa0KbDtANfRTa+OlDzGPv5pUdZAqIhUCvvDVfgjFOyzApW8X2fk1Q="
private let slotEpk = "BB8UAUa/sbJR+E9N2+DUzc/Xev2YSpUg41eUAh+DErue7JlaCLH6dwTfPcwLUKlmUmP7dxH5X5+KRJxQluR8iSs="
private let hostEpk = "BCYe+9NVDPBo7wE+1zZroy9db+VXtLKrzoreWMuhaKVeF4igsppWpqvsQITAyWvT3LymtQfzXb6p6YVwhHnYvck="
private let macEpk = "BL1XFLnCBABBHx5R2/9jZH8F0dcLVfwgDGytEML0YU3B5QSFYvcx9UVzwEIk2XOpFqWfUmqCaAdvwc+pKl8UPxk="
private let answerCt = "EpbbcSbHkfEcE401B7uuTLjVclhTayRerALyzUtNDTB7Z4iWXdY+S7OrKMew2sEj"
private let slotKek = "dd01116d9d877add3e3d39300b02d3e22fc63839f0e60c3ca5bc2942683eb1bb"

private func params(slot: String = "s2", key: String = devicePoint, hostEpk host: String = hostEpk) -> VaultUnwrapParams {
  VaultUnwrapParams(vault: vault, slot: slot, key: key, epk: slotEpk, hostEpk: host)
}

@Test func vaultKeyPointMatchesTheHostsVector() throws {
  let key = SoftwareVaultKey(try scalar(0x01))
  #expect(key.point.base64EncodedString() == devicePoint)
  #expect(VaultKeyResult(key).store == "software")
}

@Test func unwrapAnswersTheHostsVector() throws {
  let answer = try VaultUnwrap.answer(params(), key: SoftwareVaultKey(try scalar(0x01)), ephemeral: try scalar(0x61), nonce: try AES.GCM.Nonce(data: bytes(0xa0, 12)))
  #expect(answer == VaultUnwrapResult(epk: macEpk, nonce: bytes(0xa0, 12).base64EncodedString(), ct: answerCt))
}

@Test func theHostOpensTheAnswerToTheSlotsKey() throws {
  // The host's side, done here: its ephemeral key, ECDH with this side's point, the same HKDF, then AES-GCM open.
  let host = try scalar(0x41)
  let answer = try VaultUnwrap.answer(params(), key: SoftwareVaultKey(try scalar(0x01)))
  let mine = try P256.KeyAgreement.PublicKey(x963Representation: Data(base64Encoded: answer.epk)!)
  let sealing = try host.sharedSecretFromKeyAgreement(with: mine).hkdfDerivedSymmetricKey(
    using: SHA256.self, salt: mine.x963Representation + host.publicKey.x963Representation,
    sharedInfo: Data("kos-vault/2 unwrap|\(vault)|s2".utf8), outputByteCount: 32)
  let sealed = Data(base64Encoded: answer.ct)!
  let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: Data(base64Encoded: answer.nonce)!), ciphertext: sealed.prefix(32), tag: sealed.suffix(16))
  let opened = try AES.GCM.open(box, using: sealing, authenticating: Data("kos-vault/2|unwrap|\(vault)|s2".utf8))
  #expect(opened.map { String(format: "%02x", $0) }.joined() == slotKek)
}

@Test func unwrapRefusesASlotSealedToAnotherKey() throws {
  #expect(throws: DeviceError(.key, "This Mac holds another vault key: the slot was made for another Mac, or this Mac's key was made again.")) {
    try VaultUnwrap.answer(params(), key: SoftwareVaultKey())
  }
}

@Test func unwrapRefusesAPointThatIsNotOne() throws {
  let key = SoftwareVaultKey(try scalar(0x01))
  #expect(throws: DeviceError.badRequest("vault.unwrap: hostEpk is not an uncompressed P-256 point.")) {
    try VaultUnwrap.answer(params(hostEpk: Data(repeating: 4, count: 65).base64EncodedString()), key: key)
  }
}

@Test func anotherSlotGetsAnotherKey() throws {
  let key = SoftwareVaultKey(try scalar(0x01))
  let one = try VaultUnwrap.answer(params(), key: key, ephemeral: try scalar(0x61), nonce: try AES.GCM.Nonce(data: bytes(0xa0, 12)))
  let other = try VaultUnwrap.answer(params(slot: "s3"), key: key, ephemeral: try scalar(0x61), nonce: try AES.GCM.Nonce(data: bytes(0xa0, 12)))
  #expect(one.ct != other.ct)
}

@Test func loopbackAddressesAreThisComputer() throws {
  #expect(try KOSAddress("http://127.0.0.1:4317").isLoopback)
  #expect(try KOSAddress("http://localhost:4317").isLoopback)
  #expect(try !KOSAddress("https://kos.example.ts.net").isLoopback)
  #expect(try !KOSAddress("https://192.168.1.4:4317").isLoopback)
}
