import DeviceCore
import Foundation
import Security
import Testing
@testable import DeviceLink

@Suite("Server trust")
struct ServerTrustTests {
  private static let der = Data(base64Encoded: "MIIBTzCB9qADAgECAhQ3G0vY5F6M3mEbuBnBrFYuByJt2TAKBggqhkjOPQQDAjAOMQwwCgYDVQQDDANLT1MwHhcNMjYxMTEyMDcyMDQ2WhcNNDYxMTA3MDcyMDQ2WjAOMQwwCgYDVQQDDANLT1MwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAR3lYfDzX/wcwf89eXGuK0rys+vwYtEdTDOnieDFSndTrbzTxAmtgf1+ntO+AgFvbbbE51DrlOqc5uli2Uaajr0ozIwMDAdBgNVHQ4EFgQUPaB4OnluNzwcdaW39eA1pEAjzqMwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiANliQNbxnnU78FEI0w7/d+MLC9u4z8fADslMsUbCF6hwIhAOYe0Oi0F1UfLbi8ehcxjMS30VpsbczO0zeOaegUlhs2")!
  private static let pin = "5M0IYxHO9_X0el-UCBYbsqpoA5nBtVocc3d18qMjq2I"

  private func trust() throws -> SecTrust {
    let cert = try #require(SecCertificateCreateWithData(nil, Self.der as CFData))
    var trust: SecTrust?
    #expect(SecTrustCreateWithCertificates(cert, SecPolicyCreateSSL(true, "192.168.1.20" as CFString), &trust) == errSecSuccess)
    return try #require(trust)
  }

  @Test func theFarEndsPinIsItsLeafCertificates() throws {
    #expect(ServerTrust.pinOf(try trust()) == Self.pin)
  }

  @Test func aPinBoxRemembersARefusalOnce() {
    let box = PinBox()
    box.pin = Self.pin
    #expect(box.pin == Self.pin)
    #expect(!box.tookRefusal())
  }
}
