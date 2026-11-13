import DeviceKit
import Foundation
import Testing

@testable import PhoneCore

@MainActor
@Suite("Voice in")
struct VoiceTests {
  private func voice(_ given: ScriptedSpeech? = nil) -> (VoiceModel, ScriptedSpeech, Sleeps, Said) {
    let speech = given ?? ScriptedSpeech()
    let sleeps = Sleeps()
    let model = VoiceModel(recognizer: speech, pause: .seconds(1.6), settle: .seconds(1.5), sleep: sleeps.sleep)
    let said = Said()
    model.send = { said.words.append($0) }
    return (model, speech, sleeps, said)
  }

  final class Said { var words: [String] = [] }

  @Test func aPressListensAndASecondSendsWhatWasHeard() async throws {
    let (model, speech, sleeps, said) = voice()
    model.press()
    try await until("listening") { model.state == .listening }
    speech.say("what's the weather")
    #expect(model.words == "what's the weather")
    model.press()
    #expect(model.state == .finishing)
    #expect(speech.finished == 1)
    speech.say("what's the weather like", final: true)
    #expect(said.words == ["what's the weather like"])
    #expect(model.state == .idle)
    #expect(model.words.isEmpty)
    // A pause timer from the listening that ended sends nothing more.
    sleeps.fire()
    await settle()
    #expect(said.words.count == 1)
  }

  @Test func twoPressesBeforeListeningStartsStartItOnce() async throws {
    let (model, speech, _, _) = voice()
    model.press()
    model.press()
    try await until("listening") { model.state == .listening }
    await settle()
    #expect(speech.starts == 1)
  }

  @Test func aPauseInSpeakingSendsByItself() async throws {
    let (model, speech, sleeps, said) = voice()
    model.press()
    try await until("listening") { model.state == .listening }
    speech.say("call the plumber")
    try await until("the pause after the words") { sleeps.pending == [.seconds(1.6)] }
    sleeps.fire()
    try await until("finishing") { model.state == .finishing }
    // The last words are late: what was heard goes anyway.
    try await until("the wait for the last words") { sleeps.pending == [.seconds(1.5)] }
    sleeps.fire()
    try await until("the words sent") { said.words == ["call the plumber"] }
  }

  @Test func silenceBeforeAnyWordListensOnThenGivesUp() async throws {
    let (model, speech, sleeps, said) = voice()
    model.press()
    for pause in 1...VoiceModel.patience {
      try await until("pause \(pause)") { sleeps.pending == [.seconds(1.6)] }
      #expect(model.state == .listening)
      sleeps.fire()
    }
    try await until("giving up") { model.state == .idle }
    #expect(speech.cancelled == 1)
    #expect(model.note?.hasPrefix("Heard nothing") == true)
    #expect(said.words.isEmpty)
  }

  @Test func theCrossDropsWhatWasHeard() async throws {
    let (model, speech, _, said) = voice()
    model.press()
    try await until("listening") { model.state == .listening }
    speech.say("never mind")
    model.cancel()
    #expect(model.state == .idle)
    #expect(model.words.isEmpty)
    speech.say("never mind", final: true)
    #expect(said.words.isEmpty)
  }

  @Test func refusedTheMicrophoneItSaysHowToAllowIt() async throws {
    let speech = ScriptedSpeech()
    speech.access = .denied
    let (model, _, _, _) = voice(speech)
    model.press()
    try await until("unavailable") { if case .unavailable = model.state { true } else { false } }
    guard case .unavailable(let why) = model.state else { return }
    #expect(why.contains("Settings"))
    // Allowed since, a press tries again.
    speech.access = .allowed
    model.press()
    try await until("listening") { model.state == .listening }
  }

  @Test func noRecognitionHereSaysWhy() async throws {
    let none = VoiceModel(recognizer: NoSpeech())
    none.press()
    try await until("unavailable") { none.state == .unavailable("Voice is the iPhone's. Type here instead.") }
  }

  @Test func aFailureEndsListeningAndSaysSo() async throws {
    let (model, speech, _, said) = voice()
    model.press()
    try await until("listening") { model.state == .listening }
    speech.failed?("The microphone is in use.")
    #expect(model.state == .idle)
    #expect(model.note == "Did not catch that. The microphone is in use.")
    #expect(said.words.isEmpty)
  }

  @Test func nothingHeardIsSaidRatherThanSent() async throws {
    let (model, speech, _, said) = voice()
    model.press()
    try await until("listening") { model.state == .listening }
    model.press()
    speech.say("  ", final: true)
    #expect(said.words.isEmpty)
    #expect(model.note?.hasPrefix("Did not catch that") == true)
  }

  @Test func aStartThatFailsIsSaid() async throws {
    let speech = ScriptedSpeech()
    speech.refuseStart = "The microphone is busy."
    let (model, _, _, _) = voice(speech)
    model.press()
    try await until("the refusal said") { model.note == "The microphone is busy." }
    #expect(model.state == .idle)
  }

  @Test func listeningSilencesAReplyBeingRead() async throws {
    let (model, _, _, _) = voice()
    var told = 0
    model.willListen = { told += 1 }
    model.press()
    try await until("listening") { model.state == .listening }
    #expect(told == 1)
  }
}

@MainActor
@Suite("Voice out")
struct ReaderTests {
  private func reader(on: Bool = true) -> (ReplyReader, EarSpeaker, MemoryPreferences) {
    let speaker = EarSpeaker()
    let preferences = MemoryPreferences()
    let reader = ReplyReader(speaker: speaker, preferences: preferences)
    reader.on = on
    return (reader, speaker, preferences)
  }

  @Test func onlyRepliesThatLandWhileItIsOnAreRead() {
    let (reader, speaker, _) = reader()
    let history: [ChatModel.Line] = [.you("hi", files: []), .kos("Hello.")]
    reader.shown(conversation: "c1", lines: history)
    #expect(speaker.said.isEmpty)
    reader.shown(conversation: "c1", lines: history + [.you("weather?", files: []), .steps([.init(summary: "Look it up")]), .kos("**Sunny**, 21°.")])
    #expect(speaker.said == ["Sunny, 21°."])
    // Shown again with nothing new: nothing is read twice.
    reader.shown(conversation: "c1", lines: history + [.you("weather?", files: []), .steps([.init(summary: "Look it up")]), .kos("**Sunny**, 21°.")])
    #expect(speaker.said.count == 1)
  }

  @Test func anotherChatsHistoryIsNotRead() {
    let (reader, speaker, _) = reader()
    reader.shown(conversation: "c1", lines: [.kos("One.")])
    reader.shown(conversation: "c2", lines: [.kos("Two."), .kos("Three.")])
    #expect(speaker.said.isEmpty)
  }

  @Test func aChatWhoseOldestLinesWentOffItsTopStillReadsOnlyTheNew() {
    let old: [ChatModel.Line] = (0..<4).map { .kos("line \($0)") }
    let next = Array(old.dropFirst(2)) + [.you("more", files: []), .kos("New one.")]
    #expect(ReplyReader.added(from: old, to: next).map { $0 } == [.you("more", files: []), .kos("New one.")])
    #expect(ReplyReader.added(from: [.kos("a")], to: [.kos("b")]).isEmpty)
  }

  @Test func offItReadsNothingAndTurningItOffSilencesIt() {
    let (reader, speaker, preferences) = reader(on: false)
    reader.shown(conversation: "c1", lines: [])
    reader.shown(conversation: "c1", lines: [.kos("Hi.")])
    #expect(speaker.said.isEmpty)
    reader.on = true
    #expect(ReplyReader(speaker: speaker, preferences: preferences).on)
    reader.on = false
    #expect(speaker.stops == 1)
  }
}

@Suite("Spoken words")
struct SpokenWordsTests {
  @Test func theMarksGoAndTheWordsStay() {
    #expect(SpokenWords.plain("## Plan\n- **Buy** milk\n- Call _Sam_ about `notes.txt`") == "Plan Buy milk Call Sam about notes.txt")
    #expect(SpokenWords.plain("See [the doc](https://x.y/z) or https://example.com/a") == "See the doc or a link")
    #expect(SpokenWords.plain("Ask @project:garden and @chat:[c 1]") == "Ask garden and c 1")
    #expect(SpokenWords.plain("keep file_name.txt as is") == "keep file_name.txt as is")
  }

  @Test func codeAndTablesAreNamedNotSpelledOut() {
    let reply = "Here it is:\n```swift\nlet x = 1\nlet y = 2\n```\n| a | b |\n| - | - |\n| 1 | 2 |\nDone."
    #expect(SpokenWords.plain(reply) == "Here it is: There is some code on screen. There is a table on screen. Done.")
  }

  @Test func aTimeIsSaidAsItReads() {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    let said = SpokenWords.plain("Due <t:1800003600:R>.", now: now)
    #expect(!said.contains("<t:"))
    #expect(said.contains("hour"))
  }
}

@Suite("Glance words")
struct GlanceWordsTests {
  private var calendar: Calendar {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = TimeZone(identifier: "UTC")!
    c.locale = Locale(identifier: "en_US")
    return c
  }

  @Test func whenSomethingRunsNext() {
    let now = Date(timeIntervalSince1970: 1_800_000_000) // 08:00 UTC
    #expect(GlanceWords.next(now.addingTimeInterval(20), now: now, calendar: calendar) == "now")
    #expect(GlanceWords.next(now.addingTimeInterval(4 * 60), now: now, calendar: calendar) == "in 4m")
    #expect(GlanceWords.next(now.addingTimeInterval(3 * 3600), now: now, calendar: calendar) == "in 3h")
    #expect(GlanceWords.next(now.addingTimeInterval(9 * 3600), now: now, calendar: calendar) == "at 17:00")
    #expect(GlanceWords.next(now.addingTimeInterval(25 * 3600), now: now, calendar: calendar) == "tomorrow 09:00")
    #expect(GlanceWords.next(now.addingTimeInterval(3 * 86_400), now: now, calendar: calendar).hasSuffix("08:00"))
  }

  @Test func howLongAJobHasFailed() {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    #expect(GlanceWords.failingFor(since: now.addingTimeInterval(-20), now: now) == "just now")
    #expect(GlanceWords.failingFor(since: now.addingTimeInterval(-12 * 60), now: now) == "for 12m")
    #expect(GlanceWords.failingFor(since: now.addingTimeInterval(-3 * 3600), now: now) == "for 3h")
    #expect(GlanceWords.failingFor(since: now.addingTimeInterval(-3 * 86_400), now: now) == "for 3d")
    #expect(GlanceWords.streak(1) == "Failed its last run")
    #expect(GlanceWords.streak(3) == "Failed 3 runs in a row")
  }

  @Test func howLongAnAskHasLeft() {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    #expect(GlanceWords.lapses(now.addingTimeInterval(40), now: now) == "lapses in 40s")
    #expect(GlanceWords.lapses(now.addingTimeInterval(4 * 60), now: now) == "lapses in 4m")
    #expect(GlanceWords.lapses(now.addingTimeInterval(4 * 60 + 1), now: now) == "lapses in 5m")
    #expect(GlanceWords.lapses(now.addingTimeInterval(23 * 3600), now: now) == "lapses in 23h")
    #expect(GlanceWords.lapses(now.addingTimeInterval(-5), now: now) == "lapses now")
  }
}
