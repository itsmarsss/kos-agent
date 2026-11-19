import DeviceCore
import DeviceKit
import Foundation
import Testing

@testable import PhoneCore

/// KOS's asks on the lock screen: the owner asked once, after pairing and never at launch; the token told to KOS
/// over the line; Approve and Deny decided over that line on wake; a notification taken down once its ask settles.
@MainActor
@Suite("Push")
struct PushTests {
  private static let token = Data([0xab, 0xcd, 0x01, 0x23])

  private func pushBuild(_ allowed: PushPermission = .undecided) -> FakeNotifier {
    let notifier = FakeNotifier()
    notifier.environment = .sandbox
    notifier.allowed = allowed
    return notifier
  }

  @Test func neverAsksAtLaunch() async throws {
    let rig = Rig(paired: Rig.pairing, notifier: pushBuild())
    rig.phone.start()
    try await until("the owner's leave read") { rig.phone.push.permission == .undecided }
    #expect(rig.notifier.asked == 0)
    #expect(rig.notifier.registered == 0)
  }

  @Test func asksOnceRightAfterPairingAndRegisters() async throws {
    let rig = Rig(notifier: pushBuild())
    rig.phone.start()
    rig.phone.pairing.address = "kos-device://pair?url=https://192.168.1.20:4319&code=K7QX-M2PA&pin=\(Pins.kos)"
    await rig.phone.pairing.next()
    await rig.phone.pairing.confirm()
    try await until("the owner asked") { rig.notifier.registered == 1 }
    #expect(rig.notifier.asked == 1)
    #expect(rig.phone.push.permission == .allowed)
  }

  @Test func asksNothingAfterPairingOnceTheOwnerHasSaid() async throws {
    let rig = Rig(notifier: pushBuild(.denied))
    rig.phone.start()
    rig.phone.pairing.address = "kos-device://pair?url=https://192.168.1.20:4319&code=K7QX-M2PA&pin=\(Pins.kos)"
    await rig.phone.pairing.next()
    await rig.phone.pairing.confirm()
    await settle()
    #expect(rig.notifier.asked == 0)
  }

  @Test func aBuildWithNoPushAsksNothingAndTellsKOSNothing() async throws {
    let rig = try await Rig.online()
    await rig.phone.push.turnOn()
    rig.phone.push.registered(Self.token)
    #expect(!rig.phone.push.available)
    #expect(rig.notifier.asked == 0)
    #expect(!rig.line.events.contains(PushToken.event))
  }

  @Test func theTokenGoesToKOSWhenGivenAndEachTimeTheLineComesUp() async throws {
    let rig = Rig(paired: Rig.pairing, notifier: pushBuild(.allowed))
    rig.phone.start()
    try await until("registered") { rig.notifier.registered == 1 }
    // Given off the line: it waits for the line.
    rig.phone.push.registered(Self.token)
    #expect(rig.line.events.isEmpty)
    rig.line.onStatus?(.connected(name: "iPhone"))
    #expect(rig.line.events.first == PushToken.event)
    #expect(rig.line.last(PushToken.event)?["token"] as? String == "abcd0123")
    #expect(rig.line.last(PushToken.event)?["env"] as? String == "sandbox")
    // Given again on the line, it goes at once.
    rig.line.forget()
    rig.phone.push.registered(Data([0x01]))
    #expect(rig.line.last(PushToken.event)?["token"] as? String == "01")
  }

  @Test func notificationsTurnedOffInSettingsAreTakenBackFromKOS() async throws {
    let notifier = pushBuild(.allowed)
    let rig = Rig(paired: Rig.pairing, notifier: notifier)
    rig.phone.start()
    rig.line.onStatus?(.connected(name: "iPhone"))
    rig.phone.push.registered(Self.token)
    rig.line.forget()
    notifier.allowed = .denied
    rig.phone.foreground()
    try await until("KOS told to forget the token") { rig.line.last(PushToken.event)?.isEmpty == true }
    #expect(!rig.phone.push.on)
  }

  @Test func approveOnTheLockScreenDialsDecidesAndHangsUpOnceKOSSettlesIt() async throws {
    let rig = Rig(paired: Rig.pairing, notifier: pushBuild(.allowed))
    rig.phone.background()
    let decided = Task { await rig.phone.decide(fromNotification: "41", approved: true) }
    try await until("the line dialled") { rig.lines.made.count == 1 }
    #expect(rig.line.started == Rig.pairing)
    rig.line.onStatus?(.connected(name: "iPhone"))
    try await until("the decision sent") { rig.line.events.contains("chat.decide") }
    let decide = try #require(rig.line.last("chat.decide"))
    #expect(decide["approval"] as? String == "41")
    #expect(decide["approved"] as? Bool == true)
    #expect(decide["remember"] == nil)
    _ = try await rig.line.call("chat.settled", #"{"approval":"41","outcome":"approved"}"#)
    #expect(await decided.value)
    #expect(rig.line.held == 1)
    #expect(rig.notifier.withdrawn.contains("kos.ask.41"))
  }

  @Test func denyOnAPhoneAlreadyOnTheLineKeepsTheLine() async throws {
    let rig = try await Rig.online()
    let decided = Task { await rig.phone.decide(fromNotification: "41", approved: false) }
    try await until("the decision sent") { rig.line.events.contains("chat.decide") }
    #expect(rig.line.last("chat.decide")?["approved"] as? Bool == false)
    _ = try await rig.line.call("chat.settled", #"{"approval":"41","outcome":"denied"}"#)
    #expect(await decided.value)
    #expect(rig.line.held == 0)
  }

  @Test func aDecisionThatCannotReachKOSIsSaidSoTheAppCanOfferIt() async throws {
    let rig = Rig(paired: Rig.pairing)
    rig.phone.background()
    let decided = Task { await rig.phone.decide(fromNotification: "41", approved: true) }
    try await until("the wait for the line") { rig.sleeps.pending == [.seconds(10)] }
    rig.sleeps.fire()
    #expect(await !decided.value)
    #expect(!rig.line.events.contains("chat.decide"))
  }

  @Test func aDecisionKOSNeverSettlesIsNotTakenForDone() async throws {
    let rig = try await Rig.online()
    let decided = Task { await rig.phone.decide(fromNotification: "41", approved: true) }
    try await until("the decision sent") { rig.line.events.contains("chat.decide") }
    try await until("the wait for KOS") { rig.sleeps.pending.contains(.seconds(8)) }
    rig.sleeps.fire()
    #expect(await !decided.value)
  }

  @Test func unpairedThereIsNothingToDecideWith() async {
    let rig = Rig()
    #expect(await !rig.phone.decide(fromNotification: "41", approved: true))
    #expect(rig.lines.made.isEmpty)
  }

  @Test func anAskSettledElsewhereComesDownEverywhereHere() async throws {
    let rig = try await Rig.online()
    _ = try await rig.line.call("chat.ask", #"{"chat":"phone:owner","approval":{"id":"41","tool":"files.write"}}"#)
    #expect(rig.phone.chat.asks.count == 1)
    rig.phone.received(.settled("41"))
    #expect(rig.phone.chat.asks.isEmpty)
    #expect(rig.notifier.withdrawn == ["kos.ask.41"])
    // Decided in the app: its notification goes too.
    _ = try await rig.line.call("chat.ask", #"{"chat":"phone:owner","approval":{"id":"42","tool":"files.write"}}"#)
    rig.phone.chat.answer("42", approved: false)
    #expect(rig.notifier.withdrawn.last == "kos.ask.42")
  }

  @Test func aTapOpensTheAskInTheInbox() {
    let rig = Rig(paired: Rig.pairing)
    rig.phone.open(ask: "41")
    #expect(rig.phone.board.inbox.revealing == 41)
  }

  @Test func unpairingTakesDownWhatTheLastKOSPushed() async throws {
    let rig = try await Rig.online()
    rig.phone.unpair()
    #expect(rig.notifier.withdrewAll == 1)
  }
}
