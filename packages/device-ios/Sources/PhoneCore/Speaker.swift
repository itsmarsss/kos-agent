import AVFoundation
import Foundation

/// What reads KOS's replies aloud: the system's own voice, or a stand-in a test listens to.
@MainActor
public protocol Speaker: AnyObject {
  func speak(_ words: String)
  /// Stops at once, mid-word, and drops whatever was waiting to be said.
  func stop()
}

/// The system's text to speech, in the phone's own language. AVSpeechSynthesizer is on both platforms, so this
/// is the real thing on a Mac too. On an iPhone it ducks whatever plays while it speaks, and lets it back up
/// once it has nothing left to say, or is stopped.
@MainActor
public final class SystemSpeaker: NSObject, Speaker, AVSpeechSynthesizerDelegate {
  private let synthesizer = AVSpeechSynthesizer()
  #if os(iOS)
  /// The audio session this speaker made active, to let go of; never one the microphone took since.
  private var holding = false
  #endif

  public override init() {
    super.init()
    synthesizer.delegate = self
  }

  public func speak(_ words: String) {
    guard !words.isEmpty else { return }
    #if os(iOS)
    // Spoken audio over whatever plays, which ducks; the microphone's session is let go when it stops.
    let session = AVAudioSession.sharedInstance()
    try? session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
    holding = (try? session.setActive(true)) != nil
    #endif
    let utterance = AVSpeechUtterance(string: words)
    utterance.voice = AVSpeechSynthesisVoice(language: AVSpeechSynthesisVoice.currentLanguageCode())
    synthesizer.speak(utterance)
  }

  public func stop() {
    synthesizer.stopSpeaking(at: .immediate)
    release(stopped: true)
  }

  /// Nothing left to say: what was ducked comes back up. Stopped, at once, whatever the synthesizer still says.
  private func release(stopped: Bool = false) {
    #if os(iOS)
    guard holding, stopped || !synthesizer.isSpeaking else { return }
    holding = false
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    #endif
  }

  nonisolated public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    Task { @MainActor in self.release() }
  }

  nonisolated public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
    Task { @MainActor in self.release() }
  }
}
