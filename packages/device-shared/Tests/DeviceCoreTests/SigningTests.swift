import Foundation
import Testing
@testable import DeviceCore

@Suite("Handshake signatures")
struct SigningTests {
  @Test func thePayloadsAreTheProtocolsSentences() {
    #expect(String(decoding: Handshake.devicePayload(hostNonce: "N", deviceId: "dev_1"), as: UTF8.self) == "kos-device/1|device|N|dev_1")
    #expect(String(decoding: Handshake.hostPayload(deviceNonce: "M", deviceId: "dev_1"), as: UTF8.self) == "kos-device/1|host|M|dev_1")
  }

  @Test func aDeviceSignatureVerifiesUnderItsPublicKey() throws {
    let key = DeviceKey()
    let payload = Handshake.devicePayload(hostNonce: Handshake.makeNonce(), deviceId: "dev_1")
    let signature = try key.sign(payload)
    let verifier = try HostKey(base64: key.publicKeyBase64)
    #expect(verifier.verify(signature: signature, payload: payload))
    #expect(!verifier.verify(signature: signature, payload: Handshake.devicePayload(hostNonce: "other", deviceId: "dev_1")))
  }

  @Test func aKeySurvivesTheKeychainRoundTrip() throws {
    let key = DeviceKey()
    let again = try DeviceKey(raw: key.rawRepresentation)
    #expect(again.publicKeyBase64 == key.publicKeyBase64)
  }

  /// Signed by Node's crypto, the way KOS signs: the device must accept exactly this.
  @Test func acceptsASignatureMadeByKOS() throws {
    let host = try HostKey(base64: "6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=")
    let nonce = "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk="
    let signature = "oVdD9xkqNFdF/gIo4ze2R73dP8Wf0PHpjNxiW8395phZl9XoSt+AHRdIkh2+BSmmQMCrGMc8PZiUn8a3LLAYDA=="
    #expect(host.verify(signature: signature, payload: Handshake.hostPayload(deviceNonce: nonce, deviceId: "dev_test123")))
    #expect(!host.verify(signature: signature, payload: Handshake.hostPayload(deviceNonce: nonce, deviceId: "dev_other")))
    #expect(!host.verify(signature: "not base64", payload: Handshake.hostPayload(deviceNonce: nonce, deviceId: "dev_test123")))
  }

  @Test func aHostKeyMustBe32Bytes() {
    #expect(throws: DeviceError.self) { try HostKey(base64: Data(count: 16).base64EncodedString()) }
    #expect(throws: DeviceError.self) { try HostKey(base64: "%%%") }
  }

  @Test func noncesAre32RandomBytes() {
    let a = Handshake.makeNonce()
    #expect(Handshake.isValidNonce(a))
    #expect(a != Handshake.makeNonce())
    #expect(!Handshake.isValidNonce("short"))
    #expect(!Handshake.isValidNonce(Data(count: 31).base64EncodedString()))
  }
}
