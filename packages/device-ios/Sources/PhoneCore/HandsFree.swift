import Foundation

/// Asks to listen from outside the app's screens: the Ask KOS intent, which
/// runs in the app's process when Siri, Shortcuts or the Action button start
/// it. Only the intent asks; no link does, since any app or page can open one.
/// Each ask is taken once, by the scene that hears it.
@MainActor
public final class HandsFree: ObservableObject {
  public static let shared = HandsFree()

  /// Bumped at each ask, for the scene to hear.
  @Published public private(set) var asked = 0
  private var waiting = false

  public init() {}

  public func ask() {
    waiting = true
    asked += 1
  }

  /// Whether an ask is waiting, and with that it is taken: a scene that comes back later hears none.
  public func take() -> Bool {
    defer { waiting = false }
    return waiting
  }
}
