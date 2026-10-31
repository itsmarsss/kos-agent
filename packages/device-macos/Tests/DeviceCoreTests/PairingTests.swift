import Foundation
import Testing
@testable import DeviceCore

private func pairing(_ id: String, _ address: String) -> Pairing {
  Pairing(deviceId: id, address: address, hostKey: "k", deviceKey: Data(), name: "Studio")
}

@Suite("Pairings")
struct PairingTests {
  @Test func anotherKOSIsAddedAfterTheRest() {
    let home = pairing("d1", "http://127.0.0.1:4317")
    let work = pairing("d2", "https://kos.work.ts.net")
    #expect(Pairings.adding(work, to: [home]) == [home, work])
    #expect(Pairings.replaced(by: work, in: [home]).isEmpty)
  }

  @Test func pairingAgainWithAKOSReplacesItInPlace() {
    let home = pairing("d1", "http://127.0.0.1:4317")
    let work = pairing("d2", "https://kos.work.ts.net")
    // The same KOS however its address was typed: a new device id, the old line's place.
    let again = pairing("d3", "http://127.0.0.1:4317/")
    #expect(Pairings.adding(again, to: [home, work]) == [again, work])
    #expect(Pairings.replaced(by: again, in: [home, work]) == [home])
  }

  @Test func onePairingMatchingTwoLeavesOneLine() {
    let home = pairing("d1", "http://127.0.0.1:4317")
    let work = pairing("d2", "https://kos.work.ts.net")
    let moved = pairing("d2", "http://127.0.0.1:4317")
    #expect(Pairings.adding(moved, to: [home, work]) == [moved])
  }

  @Test func unpairingRemovesOnlyThatKOS() {
    let home = pairing("d1", "http://127.0.0.1:4317")
    let work = pairing("d2", "https://kos.work.ts.net")
    #expect(Pairings.removing("d1", from: [home, work]) == [work])
  }
}
