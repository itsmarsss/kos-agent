import Foundation

/// One page's worth of the dashboard, read: what it last said, whether it is
/// being read again, and why it could not be. What was read stays up while it
/// is read again, so a pull to refresh never blanks the page; a page read
/// again before the last answer is in keeps only the newest.
@MainActor
public final class Page<Value: Sendable>: ObservableObject {
  @Published public private(set) var value: Value?
  @Published public private(set) var loading = false
  /// Why the last read failed, in the owner's words; nil once one succeeds.
  @Published public private(set) var error: String?

  private let fetch: () async throws -> Value
  private var reads = 0

  public init(_ fetch: @escaping () async throws -> Value) {
    self.fetch = fetch
  }

  /// Nothing read yet, nor being read: the page shows its loading state.
  public var blank: Bool { value == nil && error == nil }

  public func refresh() async {
    reads += 1
    let read = reads
    loading = true
    defer { if read == reads { loading = false } }
    do {
      let got = try await fetch()
      guard read == reads else { return }
      value = got
      error = nil
    } catch {
      guard read == reads else { return }
      self.error = (error as? Dashboard.Refusal)?.message ?? error.localizedDescription
    }
  }

  /// Read once, when nothing has been yet: a page shown again keeps what it has until pulled.
  public func ensure() async {
    if value == nil && !loading { await refresh() }
  }

  /// What was read, changed in place: a row gone once the owner decided it, say.
  public func edit(_ change: (inout Value) -> Void) {
    guard var now = value else { return }
    change(&now)
    value = now
  }

  /// Another KOS, or none: nothing of the last one's stays.
  public func reset() {
    reads += 1
    value = nil
    loading = false
    error = nil
  }
}
