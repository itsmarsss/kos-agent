import Foundation

/// A line the phone says over its pages when something the owner did there
/// went, or did not: "Running Nightly backup", "Couldn't approve files.write".
public struct Toast: Equatable, Identifiable, Sendable {
  public enum Tone: Sendable { case done, warn }

  public let id = UUID()
  public let words: String
  public let tone: Tone

  public init(_ words: String, tone: Tone = .done) {
    self.words = words
    self.tone = tone
  }
}

/// The line on show, one at a time: a newer one takes the place of the last, and each goes by itself.
@MainActor
public final class Toasts: ObservableObject {
  @Published public private(set) var shown: Toast?

  private let lasting: Duration
  private let sleep: @Sendable (Duration) async -> Void

  public init(lasting: Duration = .seconds(3), sleep: @escaping @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) }) {
    self.lasting = lasting
    self.sleep = sleep
  }

  public func say(_ toast: Toast) {
    shown = toast
    let sleep = sleep, lasting = lasting
    Task { [weak self] in
      await sleep(lasting)
      if self?.shown?.id == toast.id { self?.shown = nil }
    }
  }

  public func dismiss() {
    shown = nil
  }
}
