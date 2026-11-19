import Foundation

/// Waits on what the phone hears, each until it holds or its time is up, checked whenever something is heard:
/// a line coming up, an ask settled. Its clock is the phone's, so a test drives it.
@MainActor
final class Waits {
  private var waiting: [(id: UUID, holds: () -> Bool, done: CheckedContinuation<Bool, Never>)] = []

  /// True once `holds` does, false when `within` runs out first.
  func until(within: Duration, sleep: @escaping @Sendable (Duration) async -> Void, _ holds: @escaping () -> Bool) async -> Bool {
    if holds() { return true }
    let id = UUID()
    return await withCheckedContinuation { done in
      waiting.append((id, holds, done))
      Task { [weak self] in
        await sleep(within)
        self?.finish(id, false)
      }
    }
  }

  /// Something was heard: every wait that now holds ends.
  func check() {
    for wait in waiting where wait.holds() { finish(wait.id, true) }
  }

  private func finish(_ id: UUID, _ held: Bool) {
    guard let at = waiting.firstIndex(where: { $0.id == id }) else { return }
    waiting.remove(at: at).done.resume(returning: held)
  }
}
