import DeviceCore
import DeviceKit
import DeviceLink
import Foundation
import Testing

@testable import PhoneCore

/// A line a test drives by hand: what the phone sent, and KOS's side played by the test.
@MainActor
final class FakeLine: Line {
  var onStatus: ((Connection.Status) -> Void)?
  var onCall: ((Call) async -> Data?)?
  var onRemoved: (() -> Void)?
  var onFace: ((FaceDrawing) -> Void)?
  var onTheme: ((DashboardTheme) -> Void)?
  var onUpdate: ((UpdateNotice) -> Void)?
  var state: () -> DeviceState = { .phone }

  private(set) var started: Pairing?
  private(set) var sent: [[String: Any]] = []
  private(set) var redialled = 0
  private(set) var unpaired = false
  private(set) var stopped = false

  func start(_ pairing: Pairing) { started = pairing }
  func hold(_ pairing: Pairing) {}
  func redialNow() { redialled += 1 }
  /// Frames held on their way, as a slow line holds them: each told gone only at `release`.
  var holding = false
  private var held: [@MainActor () -> Void] = []

  func send(_ data: Data, done: (@MainActor () -> Void)?) {
    sent.append((try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:])
    guard let done else { return }
    if holding { held.append(done) } else { done() }
  }

  func release() {
    let waiting = held
    held = []
    for done in waiting { done() }
  }
  func unpair(then done: @escaping () -> Void) {
    unpaired = true
    done()
  }
  func stop() { stopped = true }

  /// The names of the events sent, in order.
  var events: [String] { sent.compactMap { $0["name"] as? String } }

  /// The data of the last event of this name.
  func last(_ name: String) -> [String: Any]? {
    sent.last { $0["name"] as? String == name }?["data"] as? [String: Any]
  }

  func forget() { sent = [] }

  /// KOS calls the phone; its reply, read.
  func call(_ method: String, _ params: String, id: Int = 1) async throws -> [String: Any] {
    let json = #"{"t":"call","id":\#(id),"method":"\#(method)","params":\#(params)}"#
    guard case .call(let call) = try Inbound.decode(Data(json.utf8)) else { throw DeviceError.badRequest("not a call") }
    let reply = try #require(await onCall?(call))
    return try #require(JSONSerialization.jsonObject(with: reply) as? [String: Any])
  }
}

/// Sleeps a test wakes when it chooses, so a wait is tested without waiting. As `Task.sleep` does, a sleep ends at
/// once when its task is cancelled, and is no longer pending.
final class Sleeps: @unchecked Sendable {
  private let lock = NSLock()
  private var waiting: [(id: UUID, delay: Duration, done: CheckedContinuation<Void, Never>)] = []

  var sleep: @Sendable (Duration) async -> Void {
    { [self] delay in
      let id = UUID()
      await withTaskCancellationHandler {
        await withCheckedContinuation { done in
          let cancelled = lock.withLock {
            if Task.isCancelled { return true }
            waiting.append((id, delay, done))
            return false
          }
          if cancelled { done.resume() }
        }
      } onCancel: {
        wake(id)
      }
    }
  }

  var pending: [Duration] { lock.withLock { waiting.map(\.delay) } }

  /// Wakes every sleep now waiting.
  func fire() {
    let woken = lock.withLock {
      defer { waiting = [] }
      return waiting
    }
    for sleep in woken { sleep.done.resume() }
  }

  private func wake(_ id: UUID) {
    let woken = lock.withLock { waiting.firstIndex { $0.id == id }.map { waiting.remove(at: $0) } }
    woken?.done.resume()
  }
}

/// Lets tasks the test started run to their next wait: for checking that something did not happen.
@MainActor
func settle() async {
  for _ in 0..<40 { await Task.yield() }
}

/// Waits for `done`, up to `seconds`; what it was waiting for is named when it does not come.
@MainActor
func until(_ what: String, _ seconds: Double = 20, _ done: () -> Bool) async throws {
  let deadline = Date().addingTimeInterval(seconds)
  while !done() {
    guard Date() < deadline else {
      Issue.record("Timed out waiting for \(what)")
      throw DeviceError(.internal, "timed out: \(what)")
    }
    try await Task.sleep(for: .milliseconds(5))
  }
}

/// A microphone a test speaks into.
@MainActor
final class ScriptedSpeech: SpeechRecognizer {
  var access: SpeechAccess = .allowed
  var refuseStart: String?
  private(set) var heard: ((String, Bool) -> Void)?
  private(set) var failed: ((String) -> Void)?
  private(set) var finished = 0
  private(set) var cancelled = 0
  private(set) var starts = 0

  func requestAccess() async -> SpeechAccess { access }

  func start(heard: @escaping (String, Bool) -> Void, failed: @escaping (String) -> Void) throws {
    if let refuseStart { throw SpeechFailure(message: refuseStart) }
    starts += 1
    self.heard = heard
    self.failed = failed
  }

  func finish() { finished += 1 }
  func cancel() { cancelled += 1 }

  func say(_ words: String, final: Bool = false) { heard?(words, final) }
}

/// A voice a test listens to.
@MainActor
final class EarSpeaker: Speaker {
  private(set) var said: [String] = []
  private(set) var stops = 0

  func speak(_ words: String) { said.append(words) }
  func stop() { stops += 1 }
}

@MainActor
final class FeltHaptics: Haptics {
  private(set) var felt: [String] = []

  func tap() { felt.append("tap") }
  func attention() { felt.append("attention") }
  func done() { felt.append("done") }
}

/// Pairing as a test plays KOS: the pin a probe sees, and what each pair was asked with.
final class FakePairer: Pairer, @unchecked Sendable {
  var pin = Pins.kos
  var probeFails: DeviceError?
  var pairFails: DeviceError?
  private(set) var probed: [String] = []
  private(set) var pairs: [(link: PairingLink, name: String, pin: String?)] = []

  func probe(_ address: KOSAddress) async throws -> String {
    probed.append(address.base.absoluteString)
    if let probeFails { throw probeFails }
    return pin
  }

  func pair(_ link: PairingLink, name: String, pin: String?) async throws -> Pairing {
    pairs.append((link, name, pin))
    if let pairFails { throw pairFails }
    return Pairing(deviceId: "dev_phone", address: link.address.base.absoluteString, hostKey: Pins.hostKey, deviceKey: DeviceKey().rawRepresentation, name: name, pin: pin)
  }
}

enum Pins {
  /// The pin of the test certificate in device-shared's tests, and its words.
  static let kos = "5M0IYxHO9_X0el-UCBYbsqpoA5nBtVocc3d18qMjq2I"
  static let words = "E4CD 0863 11CE F7F5"
  static let hostKey = Data(repeating: 7, count: 32).base64EncodedString()
}

/// A phone over stand-ins, and the stand-ins.
@MainActor
struct Rig {
  let phone: Phone
  let vault: MemoryVault
  let pairer: FakePairer
  let speech: ScriptedSpeech
  let speaker: EarSpeaker
  let haptics: FeltHaptics
  let preferences: MemoryPreferences
  let sleeps: Sleeps
  let lines: Lines

  /// Every line the phone made, the latest last.
  @MainActor
  final class Lines {
    var made: [FakeLine] = []
    var latest: FakeLine { made.last! }
  }

  init(paired: Pairing? = nil, preferences: MemoryPreferences = MemoryPreferences()) {
    vault = MemoryVault(paired.map { [$0] } ?? [])
    pairer = FakePairer()
    speech = ScriptedSpeech()
    speaker = EarSpeaker()
    haptics = FeltHaptics()
    self.preferences = preferences
    sleeps = Sleeps()
    let lines = Lines()
    self.lines = lines
    phone = Phone(
      vault: vault, pairer: pairer, recognizer: speech, speaker: speaker, haptics: haptics, preferences: preferences,
      line: {
        let line = FakeLine()
        lines.made.append(line)
        return line
      }, timing: .init(takeWithin: .seconds(12), showWithin: .seconds(6), sleep: sleeps.sleep))
  }

  var line: FakeLine { lines.latest }

  static let pairing = Pairing(
    deviceId: "dev_phone", address: "https://192.168.1.20:4319", hostKey: Pins.hostKey, deviceKey: DeviceKey().rawRepresentation, name: "iPhone",
    pin: Pins.kos)

  /// Paired and on the line, with the chat shown.
  static func online(_ preferences: MemoryPreferences = MemoryPreferences()) async throws -> Rig {
    let rig = Rig(paired: pairing, preferences: preferences)
    rig.phone.start()
    rig.line.onStatus?(.connected(name: "iPhone"))
    _ = try await rig.line.call("chat.show", #"{"chat":"phone:owner","title":"iPhone","messages":[]}"#)
    rig.line.forget()
    return rig
  }
}
