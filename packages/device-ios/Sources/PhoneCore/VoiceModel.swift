import Foundation

/// The microphone button, as a small machine: idle, asking leave to listen,
/// listening with the words so far, finishing while the last words firm up,
/// or unavailable, with why. What it hears goes to KOS as the owner's words.
///
/// A press starts it and a press sends; a pause in speaking sends by itself,
/// so a question can be asked without touching the phone again; the cross
/// drops what was heard.
@MainActor
public final class VoiceModel: ObservableObject {
  public enum State: Equatable, Sendable {
    case idle
    case asking
    case listening
    case finishing
    /// It cannot listen: the words say why, and the keyboard is the way in.
    case unavailable(String)
  }

  @Published public private(set) var state: State = .idle
  /// What has been heard so far, while listening.
  @Published public private(set) var words = ""
  /// Said once under the button: nothing was heard, or listening failed.
  @Published public var note: String?

  /// Where the words heard go: to KOS, as the owner's.
  public var send: (String) -> Void = { _ in }
  /// Told as listening starts, so a reply being read aloud stops for the owner's voice.
  public var willListen: () -> Void = {}

  private let recognizer: SpeechRecognizer
  /// How long a pause in speaking sends what was heard.
  private let pause: Duration
  /// How long finishing waits for the last words before it sends what it has.
  private let settle: Duration
  private let sleep: @Sendable (Duration) async -> Void
  /// Bumped at every start and stop, so a late word from a listening that ended is not taken.
  private var round = 0
  private var timer: Task<Void, Never>?
  /// Pauses gone by with nothing heard yet; past `patience` of them the button gives up.
  private var quiet = 0
  /// How many pauses with nothing heard it listens through before it stops by itself.
  public static let patience = 5

  public init(
    recognizer: SpeechRecognizer, pause: Duration = .seconds(1.6), settle: Duration = .seconds(1.5),
    sleep: @escaping @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) }
  ) {
    self.recognizer = recognizer
    self.pause = pause
    self.settle = settle
    self.sleep = sleep
  }

  public var listening: Bool { state == .listening || state == .finishing }

  /// The button: start listening, or send what was heard.
  public func press() {
    switch state {
    case .idle, .unavailable:
      // Asking from the press itself, not once its task runs: a second press before then starts nothing more.
      note = nil
      state = .asking
      round += 1
      let mine = round
      Task { await begin(round: mine) }
    case .listening: finish()
    case .asking, .finishing: break
    }
  }

  /// The cross: stop listening and drop what was heard.
  public func cancel() {
    guard listening || state == .asking else { return }
    round += 1
    timer?.cancel()
    recognizer.cancel()
    words = ""
    state = .idle
  }

  private func begin(round mine: Int) async {
    let access = await recognizer.requestAccess()
    guard mine == round, state == .asking else { return }
    switch access {
    case .allowed: break
    case .denied:
      state = .unavailable("Allow the microphone and speech recognition for KOS in Settings, or type.")
      return
    case .unavailable(let why):
      state = .unavailable(why)
      return
    }
    willListen()
    words = ""
    do {
      try recognizer.start(
        heard: { [weak self] words, final in self?.heard(words, final: final, round: mine) },
        failed: { [weak self] why in self?.failed(why, round: mine) })
    } catch {
      state = .idle
      note = (error as? SpeechFailure)?.message ?? "Could not start listening."
      return
    }
    state = .listening
    quiet = 0
    wait(pause, round: mine)
  }

  private func heard(_ heard: String, final: Bool, round mine: Int) {
    guard mine == round, listening else { return }
    words = heard
    if final { return deliver() }
    // Words still coming: the pause starts again from now.
    if state == .listening { wait(pause, round: mine) }
  }

  private func failed(_ why: String, round mine: Int) {
    guard mine == round, listening else { return }
    round += 1
    timer?.cancel()
    words = ""
    state = .idle
    note = "Did not catch that. \(why)"
  }

  /// The last words are asked for; whatever has been heard goes once they come, or once they are late.
  private func finish() {
    guard state == .listening else { return }
    state = .finishing
    recognizer.finish()
    wait(settle, round: round)
  }

  private func deliver() {
    round += 1
    timer?.cancel()
    let said = words.trimmingCharacters(in: .whitespacesAndNewlines)
    words = ""
    state = .idle
    if said.isEmpty {
      note = "Did not catch that. Try again, or type."
    } else {
      send(said)
    }
  }

  /// After `delay` in this round: listening, a pause sends; finishing, the late last words are not waited for.
  private func wait(_ delay: Duration, round mine: Int) {
    timer?.cancel()
    let sleep = self.sleep
    timer = Task { [weak self] in
      await sleep(delay)
      guard !Task.isCancelled, let self, mine == self.round else { return }
      switch self.state {
      case .listening:
        // A pause before any word is heard is not the end of a question: it listens on, for a while.
        if self.words.isEmpty {
          self.quiet += 1
          guard self.quiet >= Self.patience else { return self.wait(delay, round: mine) }
          self.cancel()
          self.note = "Heard nothing. Press to try again, or type."
          return
        }
        self.finish()
      case .finishing: self.deliver()
      default: break
      }
    }
  }
}
