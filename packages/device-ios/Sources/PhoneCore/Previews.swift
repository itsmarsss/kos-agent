import DeviceCore
import DeviceKit
import DeviceLink
import Foundation

/// A line that goes nowhere: for a phone drawn in a preview or a render, filled by hand.
@MainActor
public final class QuietLine: Line {
  public var onStatus: ((Connection.Status) -> Void)?
  public var onCall: ((Call) async -> Data?)?
  public var onRemoved: (() -> Void)?
  public var onFace: ((FaceDrawing) -> Void)?
  public var onTheme: ((DashboardTheme) -> Void)?
  public var state: () -> DeviceState = { .phone }

  public init() {}

  public func start(_ pairing: Pairing) {}
  public func hold(_ pairing: Pairing) {}
  public func redialNow() {}
  public func send(_ data: Data, done: (@MainActor () -> Void)?) { done?() }
  public func unpair(then done: @escaping () -> Void) { done() }
  public func stop() {}
}

/// A voice that says nothing, for a preview.
@MainActor
public final class QuietSpeaker: Speaker {
  public init() {}
  public func speak(_ words: String) {}
  public func stop() {}
}

/// Haptics that are felt nowhere, for a preview.
public struct NoHaptics: Haptics {
  public init() {}
  public func tap() {}
  public func attention() {}
  public func done() {}
}

extension Phone {
  /// A phone over stand-ins that reach nothing, its chat filled by hand: for previews and renders.
  public static func preview(recognizer: SpeechRecognizer? = nil, preferences: Preferences = MemoryPreferences()) -> Phone {
    Phone(
      vault: MemoryVault(), pairer: NetworkPairer(), recognizer: recognizer ?? NoSpeech(), speaker: QuietSpeaker(), haptics: NoHaptics(),
      preferences: preferences, line: { QuietLine() })
  }
}
