import Testing
@testable import DeviceCore

@Suite("KOS address")
struct AddressTests {
  @Test(arguments: [
    "https://kos.example.com",
    "https://kos.example.com:8443/kos",
    "http://127.0.0.1:4317",
    "http://localhost:4317",
    "http://[::1]:4317",
    "http://100.101.102.103:4317",
    "http://kos.tail1234.ts.net:4317",
    "http://[fd7a:115c:a1e0::1]:4317",
  ])
  func allowsAnEncryptedOrPrivatePath(text: String) throws {
    _ = try KOSAddress(text)
  }

  @Test(arguments: [
    "http://192.168.1.20:4317",
    "http://kos.example.com",
    "http://100.128.0.1:4317",
    "http://100.63.255.255",
    "ftp://kos.example.com",
    "https://user:pass@kos.example.com",
    "not an address",
  ])
  func refusesEverythingElse(text: String) {
    #expect(throws: DeviceError.self) { try KOSAddress(text) }
  }

  @Test func derivesTheSocketAndPairingAddresses() throws {
    let local = try KOSAddress("http://127.0.0.1:4317/")
    #expect(local.socketURL.absoluteString == "ws://127.0.0.1:4317/api/devices/socket")
    #expect(local.pairURL.absoluteString == "http://127.0.0.1:4317/api/devices/pair")
    let remote = try KOSAddress("https://example.com/kos/?x=1#top")
    #expect(remote.socketURL.absoluteString == "wss://example.com/kos/api/devices/socket")
    #expect(remote.display == "example.com")
    #expect(local.display == "127.0.0.1:4317")
  }

  @Test func aBareAddressGetsTheSchemeItIsAllowed() throws {
    #expect(try KOSAddress("127.0.0.1:4317").base.absoluteString == "http://127.0.0.1:4317")
    #expect(try KOSAddress("kos.example.com").base.absoluteString == "https://kos.example.com")
  }
}

@Suite("Pairing link")
struct PairingLinkTests {
  @Test func readsTheDashboardsLink() throws {
    let link = try #require(try PairingLink.parse("kos-device://pair?url=http%3A%2F%2F127.0.0.1%3A4317&code=k7qx-m2pa"))
    #expect(link.address.base.absoluteString == "http://127.0.0.1:4317")
    #expect(link.code == "K7QX-M2PA")
  }

  @Test func otherTextIsNotALink() throws {
    #expect(try PairingLink.parse("https://example.com") == nil)
    #expect(try PairingLink.parse("K7QX-M2PA") == nil)
  }

  @Test func aBrokenLinkSaysWhy() {
    #expect(throws: DeviceError.self) { try PairingLink.parse("kos-device://pair?code=K7QX-M2PA") }
    #expect(throws: DeviceError.self) { try PairingLink.parse("kos-device://open?url=http://127.0.0.1&code=K7QX") }
    #expect(throws: DeviceError.self) { try PairingLink.parse("kos-device://pair?url=http://192.168.1.2&code=K7QX-M2PA") }
  }

  @Test func codesAreTidiedAndChecked() throws {
    #expect(try PairingLink.normalize(code: " k7qx-m2pa ") == "K7QX-M2PA")
    #expect(throws: DeviceError.self) { try PairingLink.normalize(code: "x") }
    #expect(throws: DeviceError.self) { try PairingLink.normalize(code: "K7QX;M2PA") }
  }
}

@Suite("Reconnect backoff")
struct BackoffTests {
  @Test func doublesUpToHalfAMinute() {
    var backoff = Backoff()
    let delays = (0..<7).map { _ in backoff.next(random: 0.5) }
    #expect(delays == [1, 2, 4, 8, 16, 30, 30])
  }

  @Test func jitterStaysWithinAFifth() {
    var low = Backoff()
    var high = Backoff()
    #expect(abs(low.next(random: 0) - 0.8) < 1e-9)
    #expect(abs(high.next(random: 1) - 1.2) < 1e-9)
  }

  @Test func resetStartsOver() {
    var backoff = Backoff()
    _ = backoff.next(random: 0.5)
    _ = backoff.next(random: 0.5)
    backoff.reset()
    #expect(backoff.next(random: 0.5) == 1)
  }
}
