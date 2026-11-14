import DeviceCore
import DeviceKit
import DeviceLink
import Foundation
import Testing

@testable import PhoneCore

/// The phone on its line: pairing kept, the chat drawn as KOS shows it, the owner's words, Stop and the asks.
@MainActor
@Suite("The phone")
struct PhoneTests {
  @Test func unpairedItShowsThePairingAndDialsNothing() {
    let rig = Rig()
    rig.phone.start()
    #expect(rig.phone.paired == nil)
    #expect(!rig.phone.chat.paired)
    #expect(rig.lines.made.isEmpty)
  }

  @Test func aPairingIsKeptAndDialledAsAPhoneThatOffersNoScreen() async throws {
    let rig = Rig()
    rig.phone.start()
    rig.phone.pairing.address = "kos-device://pair?url=https://192.168.1.20:4319&code=K7QX-M2PA&pin=\(Pins.kos)"
    await rig.phone.pairing.next()
    await rig.phone.pairing.confirm()
    #expect(try rig.vault.load().count == 1)
    #expect(rig.line.started?.pin == Pins.kos)
    #expect(rig.line.state() == .phone)
    #expect(rig.line.state().permissions == Permissions(screen: false, input: false))
    #expect(rig.haptics.felt == ["done"])
    #expect(rig.phone.chat.link == .connecting)
  }

  @Test func onTheLineItAsksForTheChatTheChatsAndTheGlance() {
    let rig = Rig(paired: Rig.pairing)
    rig.phone.start()
    #expect(rig.line.started == Rig.pairing)
    rig.line.onStatus?(.connected(name: "iPhone"))
    #expect(rig.phone.chat.online)
    #expect(rig.line.events == ["chat.open", "chat.list", "chat.glance"])
    #expect(rig.phone.glance.asking)
  }

  @Test func aKOSThatNeverShowsTheChatIsSaidToBeOneThatCannotTalkHere() async throws {
    let rig = Rig(paired: Rig.pairing)
    rig.phone.start()
    rig.line.onStatus?(.connected(name: "iPhone"))
    try await until("the wait for the chat") { rig.sleeps.pending == [.seconds(6)] }
    rig.sleeps.fire()
    try await until("the KOS said to be silent") { rig.phone.chat.silent }
  }

  @Test func theChatIsDrawnAsKOSShowsIt() async throws {
    let rig = try await Rig.online()
    let reply = try await rig.line.call("chat.show", #"{"chat":"phone:owner","title":"Groceries","messages":[{"role":"you","text":"do we need milk?"},{"role":"kos","text":"Yes."}]}"#)
    #expect(reply["ok"] as? Bool == true)
    #expect(rig.phone.chat.title == "Groceries")
    #expect(rig.phone.chat.lines.count == 2)
    #expect(!rig.phone.chat.silent)
  }

  @Test func anythingButTheChatIsRefusedForAPhoneHasNoScreen() async throws {
    let rig = try await Rig.online()
    let reply = try await rig.line.call("session.begin", #"{"session":"s1","task":"look","requester":"KOS","minutes":5}"#)
    #expect(reply["ok"] as? Bool == false)
    #expect((reply["error"] as? [String: Any])?["code"] as? String == "bad_request")
    let shot = try await rig.line.call("screen.capture", #"{"session":"s1"}"#)
    #expect(shot["ok"] as? Bool == false)
  }

  @Test func theOwnersWordsGoAsThePhonesBesideNothing() async throws {
    let rig = try await Rig.online()
    rig.phone.chat.say("what's on today?")
    let send = try #require(rig.line.last("chat.send"))
    #expect(send["text"] as? String == "what's on today?")
    #expect((send["beside"] as? [String: Any])?["kind"] as? String == "none")
    #expect(send["quote"] == nil)
    #expect(rig.phone.chat.working)
    #expect(rig.phone.chat.sending == ["what's on today?"])
  }

  @Test func wordsKOSNeverTakesComeBackToTheBox() async throws {
    let rig = try await Rig.online()
    rig.phone.chat.say("hello?")
    try await until("the wait for KOS to take the words") { rig.sleeps.pending == [.seconds(12)] }
    rig.sleeps.fire()
    try await until("the words given back") { rig.phone.chat.draft == "hello?" }
    #expect(rig.phone.chat.error?.contains("did not take") == true)
  }

  @Test func wordsKOSTakesStayAndTheTurnStreamsToItsAnswer() async throws {
    let rig = try await Rig.online()
    rig.phone.chat.say("plan my week")
    _ = try await rig.line.call("chat.status", #"{"chat":"phone:owner","said":"plan my week","taken":true}"#)
    _ = try await rig.line.call("chat.status", #"{"chat":"phone:owner","said":"plan my week","story":"› Read the calendar\nYou have three"}"#)
    #expect(rig.phone.chat.running.steps.map(\.summary) == ["Read the calendar"])
    #expect(rig.phone.chat.running.words == "You have three")
    rig.sleeps.fire()
    await settle()
    // Taken, so not given back.
    #expect(rig.phone.chat.draft.isEmpty)
    _ = try await rig.line.call("chat.status", #"{"chat":"phone:owner","said":"plan my week","story":null}"#)
    _ = try await rig.line.call("chat.show", #"{"chat":"phone:owner","title":"Week","messages":[{"role":"you","text":"plan my week"},{"role":"steps","steps":[{"summary":"Read the calendar"}]},{"role":"kos","text":"You have three meetings."}]}"#)
    #expect(!rig.phone.chat.working)
    #expect(rig.phone.chat.sending.isEmpty)
  }

  @Test func stopStopsTheTurnAndTheVoiceReadingIt() async throws {
    let rig = try await Rig.online()
    rig.phone.chat.say("summarise my inbox")
    rig.phone.chat.stop()
    #expect(rig.line.events.last == "chat.stop")
    #expect(rig.speaker.stops >= 1)
  }

  @Test func anAskIsFeltAndDecidedInOneTap() async throws {
    let rig = try await Rig.online()
    _ = try await rig.line.call("chat.ask", #"{"chat":"phone:owner","approval":{"id":"41","tool":"shell.run","mechanics":"run: touch notes.txt","why":"to make the file you asked for"}}"#)
    #expect(rig.phone.chat.asks.map(\.id) == ["41"])
    #expect(rig.haptics.felt.contains("attention"))
    rig.phone.chat.answer("41", approved: true)
    let decide = try #require(rig.line.last("chat.decide"))
    #expect(decide["approval"] as? String == "41")
    #expect(decide["approved"] as? Bool == true)
    #expect(rig.phone.chat.asks.isEmpty)
    _ = try await rig.line.call("chat.ask", #"{"chat":"phone:owner","approval":{"id":"42","tool":"fs.delete"}}"#)
    rig.phone.chat.answer("42", approved: false)
    #expect(rig.line.last("chat.decide")?["approved"] as? Bool == false)
  }

  @Test func theGlanceIsKeptAsKOSAnswersIt() async throws {
    let rig = try await Rig.online()
    _ = try await rig.line.call("chat.glance", #"{"halted":false,"running":[{"id":"c1","title":"Garden orchestrator"}],"waiting":1,"failing":[{"label":"Nightly backup","streak":3,"error":"disk full","since":1761800000000}],"next":[{"name":"kos.backup","at":1761800000000}]}"#)
    let report = try #require(rig.phone.glance.report)
    #expect(report.running.first?.title == "Garden orchestrator")
    #expect(rig.phone.glance.alarming)
    #expect(rig.phone.glance.summary == "1 running, 1 failing, 1 waiting on you")
    #expect(!rig.phone.glance.asking)
  }

  @Test func aTurnEndingAsksForAFreshGlance() async throws {
    let rig = try await Rig.online()
    rig.phone.chat.say("tidy the inbox")
    await settle()
    _ = try await rig.line.call("chat.status", #"{"chat":"phone:owner","said":"tidy the inbox","taken":true}"#)
    rig.line.forget()
    _ = try await rig.line.call("chat.status", #"{"chat":"phone:owner","said":"tidy the inbox","error":"stopped"}"#)
    try await until("the glance asked for") { rig.line.events.contains("chat.glance") }
  }

  @Test func theDashboardsThemeIsFollowedAndKeptForNextTime() async throws {
    let preferences = MemoryPreferences()
    let rig = try await Rig.online(preferences)
    #expect(rig.phone.mode == .system)
    rig.line.onTheme?(DashboardTheme(mode: .system, drawn: .dark))
    #expect(rig.phone.mode == .dark)
    rig.line.onTheme?(DashboardTheme(mode: .light, drawn: .light))
    #expect(rig.phone.mode == .light)
    // The next launch opens in it, before KOS says.
    let again = Rig(paired: Rig.pairing, preferences: preferences)
    #expect(again.phone.mode == .light)
  }

  @Test func theFaceKOSSendsIsDrawnAndKept() async throws {
    let preferences = MemoryPreferences()
    let rig = try await Rig.online(preferences)
    let face = try JSONDecoder().decode(FaceDrawing.self, from: Data(##"{"fill":"#8b5cf6","ink":"#1a1429","eyes":"sparkle","gait":1,"shape":{"aspect":1,"squat":0.1,"spread":0.97,"lobes":[]}}"##.utf8))
    rig.line.onFace?(face)
    #expect(rig.phone.chat.face.fill == 0x8B5CF6)
    #expect(Rig(paired: Rig.pairing, preferences: preferences).phone.chat.face.fill == 0x8B5CF6)
  }

  @Test func aNewerBuildIsReadyWhenKOSSaysThisOneIsBehindAndForgottenWithThePairing() async throws {
    let rig = try await Rig.online()
    #expect(!rig.phone.updateReady)
    let build = Build(id: "0123456789ab", commit: String(repeating: "b", count: 40))
    rig.line.onUpdate?(UpdateNotice(state: .behind, build: build, reason: .xcode))
    #expect(rig.phone.updateReady)
    #expect(rig.phone.update?.build == build)
    rig.line.onUpdate?(UpdateNotice(state: .current, build: build))
    #expect(!rig.phone.updateReady)
    rig.line.onUpdate?(UpdateNotice(state: .behind, build: build, reason: .xcode))
    rig.phone.unpair()
    #expect(rig.phone.update == nil)
  }

  @Test func unpairingTellsKOSAndForgetsItHere() async throws {
    let rig = try await Rig.online()
    let line = rig.line
    rig.phone.unpair()
    #expect(line.unpaired)
    #expect(try rig.vault.load().isEmpty)
    #expect(rig.phone.paired == nil)
    #expect(!rig.phone.chat.paired)
    #expect(rig.phone.chat.lines.isEmpty)
  }

  @Test func aLinkOpenedWhilePairedReplacesThePairingOnlyOnceTheOwnerSaysSo() async throws {
    let rig = try await Rig.online()
    let old = rig.line
    await rig.phone.pairing.open(URL(string: "kos-device://pair?url=https://192.168.1.31:4319&code=K7QX-M2PA&pin=\(Pins.kos)")!)
    // Asked, nothing sent, the pairing as it was.
    guard case .replace = rig.phone.pairing.step else { Issue.record("not asking to replace"); return }
    #expect(rig.pairer.pairs.isEmpty)
    #expect(rig.phone.paired == Rig.pairing)
    await rig.phone.pairing.replace()
    await rig.phone.pairing.confirm()
    // The KOS it replaced is told to forget this phone, and is heard no more.
    #expect(old.unpaired)
    #expect(old.onRemoved == nil)
    #expect(rig.phone.paired?.address == "https://192.168.1.31:4319")
    #expect(try rig.vault.load().map(\.address) == ["https://192.168.1.31:4319"])
    #expect(rig.lines.made.count == 2)
    #expect(rig.line.started?.address == "https://192.168.1.31:4319")
  }

  @Test func aGlancesAskIsDecidedFromThePhoneAndGoesFromBothPlaces() async throws {
    let rig = try await Rig.online()
    let glance = #"{"waiting":2,"asks":[{"chat":{"id":"c2","title":"Inbox sweep"},"approval":{"id":"41","tool":"files.write","why":"Saving the list."}},{"approval":{"id":"42","tool":"shell.run"}}]}"#
    _ = try await rig.line.call("chat.glance", glance)
    #expect(rig.phone.glance.asks.map(\.id) == ["41", "42"])
    #expect(rig.phone.glance.asks.first?.chat == "Inbox sweep")
    rig.phone.glance.answer("41", approved: true)
    #expect(rig.line.last("chat.decide")?["approval"] as? String == "41")
    #expect(rig.line.last("chat.decide")?["approved"] as? Bool == true)
    #expect(rig.phone.glance.asks.map(\.id) == ["42"])
    #expect(rig.phone.glance.waiting == 1)
    // Decided elsewhere, it goes from the glance as from the chat.
    _ = try await rig.line.call("chat.settled", #"{"approval":"42","outcome":"approved"}"#)
    #expect(rig.phone.glance.asks.isEmpty)
    #expect(rig.phone.glance.waiting == 0)
  }

  @Test func aKOSThatForgotThePhoneSendsItBackToPairing() async throws {
    let rig = try await Rig.online()
    rig.line.onRemoved?()
    #expect(rig.phone.paired == nil)
    #expect(try rig.vault.load().isEmpty)
    #expect(rig.phone.pairing.error?.contains("Pair it again") == true)
  }

  @Test func backOnScreenADroppedLineIsDialledAndAnOpenOneAsksAfresh() async throws {
    let rig = try await Rig.online()
    rig.phone.foreground()
    #expect(rig.line.events == ["chat.open", "chat.list", "chat.glance"])
    rig.line.onStatus?(.offline("KOS is not answering."))
    #expect(rig.phone.chat.link == .offline("KOS is not answering."))
    rig.phone.foreground()
    #expect(rig.line.redialled == 1)
  }

  @Test func wordsOnTheirWayWhenTheLineDropsComeBack() async throws {
    let rig = try await Rig.online()
    rig.phone.chat.say("are you there?")
    rig.line.onStatus?(.offline("KOS is not answering."))
    #expect(rig.phone.chat.draft == "are you there?")
  }

  @Test func aStoreThatRefusesIsSaid() {
    let rig = Rig()
    rig.vault.refuses = true
    rig.phone.start()
    #expect(rig.phone.problem == "The store refused.")
  }

  @Test func voiceGoesToKOSAsTheOwnersWords() async throws {
    let rig = try await Rig.online()
    rig.phone.voice.press()
    try await until("listening") { rig.phone.voice.state == .listening }
    rig.speech.say("remind me to call mum", final: true)
    #expect(rig.line.last("chat.send")?["text"] as? String == "remind me to call mum")
  }
}
