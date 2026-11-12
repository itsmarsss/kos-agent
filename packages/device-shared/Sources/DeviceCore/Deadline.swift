import Foundation

/// Work given a time limit it cannot overrun: past the limit the caller is answered with an error at once, whether or
/// not the work ever ends. Unlike a task group, which waits for every child, a call that hangs (an input event the
/// system never takes) does not hold the caller, so what the caller set up for it (a window letting clicks through)
/// is put back.
public enum Deadline {
  public static func run<T: Sendable>(
    seconds: TimeInterval,
    timedOut: @escaping @Sendable () -> Error,
    _ work: @escaping @Sendable () async throws -> T
  ) async throws -> T {
    let once = Once()
    return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<T, Error>) in
      let worker = Task {
        do {
          let value = try await work()
          if once.claim() { continuation.resume(returning: value) }
        } catch {
          if once.claim() { continuation.resume(throwing: error) }
        }
      }
      Task {
        try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
        if once.claim() {
          worker.cancel()
          continuation.resume(throwing: timedOut())
        }
      }
    }
  }
}

/// Lets exactly one of several racers through.
private final class Once: @unchecked Sendable {
  private let lock = NSLock()
  private var done = false

  func claim() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if done { return false }
    done = true
    return true
  }
}
