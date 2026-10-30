import AppKit
import DeviceUI
import SwiftUI

/// The owner's yes or no to a session, asked on this Mac.
///
/// Says who is asking and for what, offers how long, and declines on its
/// own after a minute so a Mac nobody is at says no. It floats over
/// everything but never takes the app in front away from the owner.
@MainActor
final class ConsentPrompt: NSObject {
  struct Request {
    let task: String
    let requester: String
    let offered: [Int]
  }

  enum Answer: Equatable {
    case allowed(minutes: Int)
    case denied
    case unanswered
    case withdrawn
  }

  static let timeout = 60

  private var panel: NSPanel?
  private var model: ConsentModel?
  private var continuation: CheckedContinuation<Answer, Never>?
  private var timer: Timer?

  func ask(_ request: Request) async -> Answer {
    finish(.withdrawn)
    return await withCheckedContinuation { continuation in
      self.continuation = continuation
      present(request)
    }
  }

  /// Withdraws the question: KOS went away before the owner answered.
  func cancel() {
    finish(.withdrawn)
  }

  private func present(_ request: Request) {
    let model = ConsentModel(task: request.task, requester: request.requester, offered: request.offered, timeout: Self.timeout)
    model.allow = { [weak self] minutes in self?.finish(.allowed(minutes: minutes)) }
    model.deny = { [weak self] in self?.finish(.denied) }
    self.model = model

    let host = NSHostingView(rootView: ConsentView(model: model))
    let panel = NSPanel(
      contentRect: CGRect(origin: .zero, size: host.fittingSize),
      styleMask: [.titled, .nonactivatingPanel, .fullSizeContentView], backing: .buffered, defer: false)
    panel.titleVisibility = .hidden
    panel.titlebarAppearsTransparent = true
    panel.isMovableByWindowBackground = true
    panel.isFloatingPanel = true
    panel.hidesOnDeactivate = false
    panel.level = NSWindow.Level(rawValue: NSWindow.Level.screenSaver.rawValue + 2)
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.isReleasedWhenClosed = false
    panel.appearance = NSAppearance(named: .darkAqua)
    panel.backgroundColor = NSColor(srgbRed: 0x0C / 255, green: 0x0E / 255, blue: 0x12 / 255, alpha: 1)
    panel.contentView = host
    if let screen = Displays.screen(for: Displays.underCursor()) {
      let size = panel.frame.size
      panel.setFrameOrigin(CGPoint(x: screen.visibleFrame.midX - size.width / 2, y: screen.visibleFrame.midY - size.height / 2 + 80))
    }
    panel.makeKeyAndOrderFront(nil)
    self.panel = panel
    NSApp.requestUserAttention(.criticalRequest)
    NSSound(named: "Glass")?.play()

    timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.tick() }
    }
  }

  private func tick() {
    guard let model else { return }
    model.remaining -= 1
    if model.remaining <= 0 { finish(.unanswered) }
  }

  private func finish(_ answer: Answer) {
    timer?.invalidate()
    timer = nil
    panel?.orderOut(nil)
    panel = nil
    model = nil
    let waiting = continuation
    continuation = nil
    waiting?.resume(returning: answer)
  }
}
