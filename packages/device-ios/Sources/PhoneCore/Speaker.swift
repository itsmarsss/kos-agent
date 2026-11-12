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
/// is the real thing on a Mac too.
@MainActor
public final class SystemSpeaker: Speaker {
  private let synthesizer = AVSpeechSynthesizer()

  public init() {}

  public func speak(_ words: String) {
    guard !words.isEmpty else { return }
    #if os(iOS)
    // Spoken audio over whatever plays, which ducks; the microphone's session is let go when it stops.
    try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
    try? AVAudioSession.sharedInstance().setActive(true)
    #endif
    let utterance = AVSpeechUtterance(string: words)
    utterance.voice = AVSpeechSynthesisVoice(language: AVSpeechSynthesisVoice.currentLanguageCode())
    synthesizer.speak(utterance)
  }

  public func stop() {
    synthesizer.stopSpeaking(at: .immediate)
  }
}
