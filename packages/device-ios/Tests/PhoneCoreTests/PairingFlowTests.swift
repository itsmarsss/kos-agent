import DeviceCore
import Foundation
import Testing

@testable import PhoneCore

@MainActor
@Suite("Pairing")
struct PairingFlowTests {
  private func flow(_ pairer: FakePairer = FakePairer()) -> (PairingFlow, FakePairer, Box) {
    let flow = PairingFlow(pairer: pairer)
    let box = Box()
    flow.paired = { box.pairing = $0 }
    return (flow, pairer, box)
  }

  final class Box { var pairing: Pairing? }

  @Test func aLinkWithItsPinShowsItsWordsThenPairsToThatCertificate() async throws {
    let (flow, pairer, box) = flow()
    flow.address = "kos-device://pair?url=https://192.168.1.20:4319&code=K7QX-M2PA&pin=\(Pins.kos)"
    #expect(flow.canContinue)
    await flow.next()
    // Nothing sent, nothing even asked: the link's pin is its words.
    #expect(pairer.probed.isEmpty)
    #expect(pairer.pairs.isEmpty)
    guard case .confirm(let check) = flow.step else { Issue.record("not asking to compare"); return }
    #expect(check.link.address.display == "192.168.1.20:4319")
    #expect(check.words == Pins.words)
    await flow.confirm()
    #expect(pairer.pairs.first?.pin == Pins.kos)
    #expect(pairer.pairs.first?.link.code == "K7QX-M2PA")
    #expect(box.pairing?.pin == Pins.kos)
    #expect(flow.step == .enter)
    #expect(flow.address.isEmpty)
  }

  @Test func aLinkToAKOSACertificateAuthorityVouchesForIsAgreedToFirst() async {
    let (flow, pairer, _) = flow()
    flow.address = "kos-device://pair?url=https://kos.example.ts.net&code=K7QX-M2PA"
    await flow.next()
    #expect(pairer.pairs.isEmpty)
    guard case .confirm(let check) = flow.step else { Issue.record("not asking"); return }
    #expect(check.words == nil)
    #expect(check.pin == nil)
    await flow.confirm()
    #expect(pairer.pairs.count == 1)
  }

  @Test func anAddressOnTheWiFiShowsTheCertificatesWordsBeforeTheCodeGoes() async throws {
    let (flow, pairer, box) = flow()
    flow.address = "192.168.1.20:4319"
    flow.code = "k7qx m2pa"
    flow.name = "Marcus's iPhone"
    await flow.next()
    #expect(pairer.probed == ["https://192.168.1.20:4319"])
    // Nothing was sent with the code yet.
    #expect(pairer.pairs.isEmpty)
    guard case .confirm(let check) = flow.step else { Issue.record("not asking to compare"); return }
    #expect(check.words == Pins.words)
    await flow.confirm()
    let pair = try #require(pairer.pairs.first)
    #expect(pair.pin == Pins.kos)
    #expect(pair.link.code == "K7QXM2PA")
    #expect(pair.name == "Marcus's iPhone")
    #expect(box.pairing != nil)
  }

  @Test func wordsThatDoNotMatchGoBackAndSendNothing() async {
    let (flow, pairer, _) = flow()
    flow.address = "192.168.1.20:4319"
    flow.code = "K7QX-M2PA"
    await flow.next()
    flow.back()
    #expect(flow.step == .enter)
    #expect(pairer.pairs.isEmpty)
    // Still what was typed, to correct.
    #expect(flow.address == "192.168.1.20:4319")
  }

  @Test func plainHTTPOnTheWiFiIsReadAsHTTPS() async {
    let (flow, pairer, _) = flow()
    flow.address = "http://192.168.1.20:4319"
    flow.code = "K7QX-M2PA"
    await flow.next()
    #expect(pairer.probed == ["https://192.168.1.20:4319"])
  }

  @Test func aKOSACertificateAuthorityVouchesForPairsWithoutAPin() async {
    let (flow, pairer, _) = flow()
    flow.address = "https://kos.example.ts.net"
    flow.code = "K7QX-M2PA"
    await flow.next()
    #expect(pairer.probed.isEmpty)
    #expect(pairer.pairs.count == 1)
    #expect(pairer.pairs.first?.pin == nil)
  }

  @Test func whatIsMissingOrWrongIsSaid() async {
    let (flow, pairer, _) = flow()
    flow.address = "192.168.1.20:4319"
    #expect(!flow.canContinue)
    await flow.next()
    #expect(flow.error?.contains("code") == true)
    flow.code = "K7QX-M2PA"
    #expect(flow.error == nil)
    pairer.probeFails = DeviceError(.internal, "Could not reach KOS at 192.168.1.20:4319.")
    await flow.next()
    #expect(flow.step == .enter)
    #expect(flow.error == "Could not reach KOS at 192.168.1.20:4319.")
    pairer.probeFails = nil
    pairer.pairFails = DeviceError(.denied, "That code is wrong, used or expired. Make a new one in KOS.")
    await flow.next()
    await flow.confirm()
    #expect(flow.error?.hasPrefix("That code is wrong") == true)
  }

  @Test func aLinkOpenedFromElsewhereSendsNothingUntilTheOwnerSaysSo() async {
    let (flow, pairer, _) = flow()
    await flow.open(URL(string: "kos-device://pair?url=https://192.168.1.20:4319&code=K7QX-M2PA&pin=\(Pins.kos)")!)
    #expect(pairer.pairs.isEmpty)
    #expect(flow.underway)
    flow.dismiss()
    #expect(flow.step == .enter)
    #expect(flow.address.isEmpty)
    #expect(pairer.pairs.isEmpty)
    await flow.open(URL(string: "https://example.com")!)
    #expect(!flow.underway)
  }

  @Test func whilePairedALinkAsksToReplaceThePairingBeforeAnythingElse() async throws {
    let (flow, pairer, box) = flow()
    flow.current = { "https://192.168.1.20:4319" }
    await flow.open(URL(string: "kos-device://pair?url=https://192.168.1.31:4319&code=K7QX-M2PA&pin=\(Pins.kos)")!)
    guard case .replace(let entered) = flow.step else { Issue.record("not asking to replace"); return }
    #expect(entered.link.address.display == "192.168.1.31:4319")
    #expect(entered.fromLink)
    // Asked, and not yet compared: nothing goes.
    await flow.confirm()
    #expect(pairer.pairs.isEmpty)
    await flow.replace()
    guard case .confirm(let check) = flow.step else { Issue.record("not asking to compare"); return }
    #expect(check.words == Pins.words)
    await flow.confirm()
    #expect(pairer.pairs.count == 1)
    #expect(box.pairing != nil)
  }

  @Test func whilePairedAnAddressTypedAsksToReplaceToo() async {
    let (flow, pairer, _) = flow()
    flow.current = { "https://192.168.1.20:4319" }
    flow.address = "https://kos.example.ts.net"
    flow.code = "K7QX-M2PA"
    await flow.next()
    guard case .replace(let entered) = flow.step else { Issue.record("not asking to replace"); return }
    #expect(!entered.fromLink)
    flow.dismiss()
    #expect(pairer.pairs.isEmpty)
    #expect(flow.code.isEmpty)
  }

  @Test func aCertificateAskedForBeforeGoingBackIsNotShownForTheNextKOS() async throws {
    let gated = GatedPairer()
    let flow = PairingFlow(pairer: gated)
    flow.address = "192.168.1.20:4319"
    flow.code = "K7QX-M2PA"
    let first = Task { await flow.next() }
    await gated.until(1)
    flow.back()
    flow.address = "192.168.1.31:4319"
    let second = Task { await flow.next() }
    await gated.until(2)
    // The first KOS answers late: the owner is still waiting on the second.
    gated.answer(0, Pins.kos)
    await first.value
    #expect(flow.step == .checking)
    gated.answer(1, Pins.kos)
    await second.value
    guard case .confirm(let check) = flow.step else { Issue.record("not asking to compare"); return }
    #expect(check.link.address.display == "192.168.1.31:4319")
  }

  @Test func aLinkOpenedWhileTheOwnerIsAskedIsLetGo() async throws {
    let (flow, pairer, _) = flow()
    await flow.open(URL(string: "kos-device://pair?url=https://192.168.1.20:4319&code=K7QX-M2PA&pin=\(Pins.kos)")!)
    guard case .confirm(let shown) = flow.step else { Issue.record("not asking to compare"); return }
    await flow.open(URL(string: "kos-device://pair?url=https://192.168.1.66:4319&code=ZZZZ-ZZZZ&pin=\(Pins.kos)")!)
    #expect(flow.step == .confirm(shown))
    flow.current = { "https://192.168.1.20:4319" }
    flow.dismiss()
    await flow.open(URL(string: "kos-device://pair?url=https://192.168.1.31:4319&code=K7QX-M2PA&pin=\(Pins.kos)")!)
    guard case .replace(let asked) = flow.step else { Issue.record("not asking to replace"); return }
    await flow.open(URL(string: "kos-device://pair?url=https://192.168.1.66:4319&code=ZZZZ-ZZZZ&pin=\(Pins.kos)")!)
    #expect(flow.step == .replace(asked))
    #expect(pairer.pairs.isEmpty)
  }
}

/// A pairer whose certificates come when the test says, one per ask, in order.
final class GatedPairer: Pairer, @unchecked Sendable {
  private let lock = NSLock()
  private var asked: [CheckedContinuation<String, Error>] = []

  func probe(_ address: KOSAddress) async throws -> String {
    try await withCheckedThrowingContinuation { answer in lock.withLock { asked.append(answer) } }
  }

  func pair(_ link: PairingLink, name: String, pin: String?) async throws -> Pairing {
    Pairing(deviceId: "dev_phone", address: link.address.base.absoluteString, hostKey: Pins.hostKey, deviceKey: DeviceKey().rawRepresentation, name: name, pin: pin)
  }

  /// Waits until `count` certificates have been asked for.
  func until(_ count: Int) async {
    while lock.withLock({ asked.count }) < count { await Task.yield() }
  }

  func answer(_ index: Int, _ pin: String) {
    lock.withLock { asked[index] }.resume(returning: pin)
  }
}
