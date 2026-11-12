import Foundation
import Testing
@testable import DeviceCore

/// A self-signed P-256 certificate, as KOS's listener on the local network makes one, and its pin as openssl says it.
enum Fixture {
  static let der = Data(base64Encoded: "MIIBTzCB9qADAgECAhQ3G0vY5F6M3mEbuBnBrFYuByJt2TAKBggqhkjOPQQDAjAOMQwwCgYDVQQDDANLT1MwHhcNMjYxMTEyMDcyMDQ2WhcNNDYxMTA3MDcyMDQ2WjAOMQwwCgYDVQQDDANLT1MwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAR3lYfDzX/wcwf89eXGuK0rys+vwYtEdTDOnieDFSndTrbzTxAmtgf1+ntO+AgFvbbbE51DrlOqc5uli2Uaajr0ozIwMDAdBgNVHQ4EFgQUPaB4OnluNzwcdaW39eA1pEAjzqMwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiANliQNbxnnU78FEI0w7/d+MLC9u4z8fADslMsUbCF6hwIhAOYe0Oi0F1UfLbi8ehcxjMS30VpsbczO0zeOaegUlhs2")!
  static let pin = "5M0IYxHO9_X0el-UCBYbsqpoA5nBtVocc3d18qMjq2I"
}

@Suite("Certificate pins")
struct CertificatePinTests {
  @Test func aPinIsTheCertificatesHashInBase64URL() {
    #expect(CertificatePin.of(der: Fixture.der) == Fixture.pin)
    #expect(CertificatePin.isValid(Fixture.pin))
  }

  @Test func itsWordsAreTheHashsFirstEightBytesInFours() {
    // sha256 e4cd086311cef7f5...
    #expect(CertificatePin.words(Fixture.pin) == "E4CD 0863 11CE F7F5")
  }

  @Test func textThatIsNoPinIsRefused() {
    #expect(!CertificatePin.isValid(""))
    #expect(!CertificatePin.isValid("short"))
    #expect(!CertificatePin.isValid(Fixture.pin + "AA"))
    // Standard base64 and padding are not how a pin is written.
    #expect(!CertificatePin.isValid("5M0IYxHO9/X0el+UCBYbsqpoA5nBtVocc3d18qMjq2I="))
    #expect(CertificatePin.words("not a pin") == nil)
  }

  @Test func aLinkMayCarryAPinAndOneThatDoesNotReadIsRefused() throws {
    let link = try #require(try PairingLink.parse("kos-device://pair?url=https://192.168.1.20:4319&code=k7qx-m2pa&pin=\(Fixture.pin)"))
    #expect(link.pin == Fixture.pin)
    #expect(link.code == "K7QX-M2PA")
    #expect(link.address.isLocalNetwork)
    #expect(throws: DeviceError.self) { try PairingLink.parse("kos-device://pair?url=https://192.168.1.20:4319&code=K7QX-M2PA&pin=nope") }
    #expect(try PairingLink.parse("kos-device://pair?url=http://127.0.0.1:4317&code=K7QX-M2PA")?.pin == nil)
  }

  @Test func aPairingFromBeforePinsStillReadsAndAPinnedOneKeepsItsPin() throws {
    let old = #"[{"deviceId":"d1","address":"http://127.0.0.1:4317","hostKey":"k","deviceKey":"","name":"Studio"}]"#
    let read = try JSONDecoder().decode([Pairing].self, from: Data(old.utf8))
    #expect(read.first?.pin == nil)
    let pinned = Pairing(deviceId: "d2", address: "https://192.168.1.20:4319", hostKey: "k", deviceKey: Data(), name: "Phone", pin: Fixture.pin)
    let again = try JSONDecoder().decode(Pairing.self, from: JSONEncoder().encode(pinned))
    #expect(again == pinned)
  }
}

@Suite("The local network")
struct LocalNetworkTests {
  private func local(_ text: String) throws -> Bool { try KOSAddress(text).isLocalNetwork }

  @Test func privateAndLinkLocalAddressesAreTheLocalNetwork() throws {
    for text in ["https://192.168.1.20:4319", "10.0.0.7:4319", "https://172.16.4.2", "https://172.31.255.1", "https://169.254.10.1", "https://studio.local:4319", "https://[fe80::1]:4319", "https://[fd12::5]"] {
      #expect(try local(text), "\(text)")
    }
  }

  @Test func elsewhereIsNot() throws {
    for text in ["https://172.32.0.1", "https://8.8.8.8", "https://kos.example.ts.net", "http://127.0.0.1:4317", "http://100.101.102.103", "https://kos.example.com", "http://[fd7a:115c:a1e0::1]"] {
      #expect(try !local(text), "\(text)")
    }
  }

  @Test func anAddressTypedBareOnTheLocalNetworkIsHTTPS() throws {
    #expect(try KOSAddress("192.168.1.20:4319").base.absoluteString == "https://192.168.1.20:4319")
    #expect(try KOSAddress("192.168.1.20:4319").lanURL.absoluteString == "https://192.168.1.20:4319/api/devices/lan")
    #expect(throws: DeviceError.self) { try KOSAddress("http://192.168.1.20:4319") }
  }
}
