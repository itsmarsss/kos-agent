import Foundation

/// Whether the phone may listen: allowed, or why not, in words the owner can act on.
public enum SpeechAccess: Equatable, Sendable {
  case allowed
  case denied
  case unavailable(String)
}

/// Words heard through the microphone, as they firm up. The iPhone's own
/// speech recognition (SystemSpeechRecognizer), or a stand-in where there is
/// none, as on a Mac running the app to look at it.
@MainActor
public protocol SpeechRecognizer: AnyObject {
  /// Asks for the microphone and speech recognition the first time; after that it answers at once.
  func requestAccess() async -> SpeechAccess
  /// Starts listening. The words so far come through `heard` as they firm up, the last of them with `final`
  /// true; a failure comes through `failed`, once, and ends the listening.
  func start(heard: @escaping (_ words: String, _ final: Bool) -> Void, failed: @escaping (String) -> Void) throws
  /// Stops listening: the words heard so far come once more, as final.
  func finish()
  /// Stops listening and drops what was heard.
  func cancel()
}

/// No microphone to listen with: the box and the keyboard's own dictation are the way in.
@MainActor
public final class NoSpeech: SpeechRecognizer {
  private let why: String

  public init(_ why: String = "Voice is the iPhone's. Type here instead.") {
    self.why = why
  }

  public func requestAccess() async -> SpeechAccess { .unavailable(why) }
  public func start(heard: @escaping (String, Bool) -> Void, failed: @escaping (String) -> Void) throws {
    throw SpeechFailure(message: why)
  }
  public func finish() {}
  public func cancel() {}
}

public struct SpeechFailure: Error, Equatable {
  public let message: String

  public init(message: String) {
    self.message = message
  }
}

#if os(iOS)
import AVFoundation
import Speech

/// The iPhone's own speech recognition, on the device where it can be, over the microphone.
@MainActor
public final class SystemSpeechRecognizer: SpeechRecognizer {
  private let recognizer = SFSpeechRecognizer()
  private let engine = AVAudioEngine()
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var tapped = false

  public init() {}

  public func requestAccess() async -> SpeechAccess {
    guard let recognizer, recognizer.isAvailable else {
      return .unavailable("Speech recognition is not available right now. Type, or use the keyboard's microphone.")
    }
    let speech = await withCheckedContinuation { (done: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in
      SFSpeechRecognizer.requestAuthorization { done.resume(returning: $0) }
    }
    guard speech == .authorized else { return speech == .restricted ? .unavailable("Speech recognition is restricted on this iPhone.") : .denied }
    return await AVAudioApplication.requestRecordPermission() ? .allowed : .denied
  }

  public func start(heard: @escaping (String, Bool) -> Void, failed: @escaping (String) -> Void) throws {
    cancel()
    guard let recognizer else { throw SpeechFailure(message: "Speech recognition is not available.") }
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.playAndRecord, mode: .measurement, options: [.duckOthers, .defaultToSpeaker])
    try session.setActive(true, options: .notifyOthersOnDeactivation)

    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    request.addsPunctuation = true
    // Kept on the iPhone where it can be: the owner's words go to KOS, and nowhere else.
    if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
    self.request = request

    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    // No input to hear (another app holds the microphone, or a call does): a tap on it would trap.
    guard format.sampleRate > 0, format.channelCount > 0 else {
      release()
      throw SpeechFailure(message: "The microphone is busy right now. Try again in a moment, or type.")
    }
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
      request.append(buffer)
    }
    tapped = true
    engine.prepare()
    try engine.start()

    task = recognizer.recognitionTask(with: request) { [weak self] result, error in
      let words = result?.bestTranscription.formattedString
      let final = result?.isFinal ?? false
      let failure = error?.localizedDescription
      Task { @MainActor in
        if let words { heard(words, final || failure != nil) }
        if final || failure != nil { self?.release() }
        if words == nil, let failure { failed(failure) }
      }
    }
  }

  public func finish() {
    stopAudio()
    request?.endAudio()
  }

  public func cancel() {
    task?.cancel()
    release()
  }

  private func release() {
    stopAudio()
    request?.endAudio()
    request = nil
    task = nil
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  private func stopAudio() {
    if engine.isRunning { engine.stop() }
    if tapped {
      engine.inputNode.removeTap(onBus: 0)
      tapped = false
    }
  }
}
#endif
