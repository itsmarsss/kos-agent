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
    let chat: URL?
    let offered: [Int]
    /// The owner's longest session, the most a custom length may be.
    let longest: Int
    /// Seconds before it says no by itself.
    let wait: Int
    /// The screen and the open windows, and which is chosen to start with.
    let targets: [TargetChoice]
    let target: String
    /// The app KOS asked to work in.
    let suggested: String?
  }

  enum Answer: Equatable {
    case allowed(minutes: Int, target: String)
    case denied
    case unanswered
    case withdrawn
  }

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
    let model = ConsentModel(
      task: request.task, requester: request.requester, chat: request.chat, offered: request.offered,
      longest: request.longest, timeout: request.wait)
    model.targets = request.targets
    model.target = request.target
    model.suggested = request.suggested
    model.allow = { [weak self] minutes, target in self?.finish(.allowed(minutes: minutes, target: target)) }
    // Each choice's picture, as it comes: the prompt does not wait on them.
    for (index, choice) in request.targets.enumerated() {
      Task { [weak model] in
        let picture: NSImage?
        if let window = UInt32(choice.id) {
          picture = await WindowCatalog.thumbnail(of: window)
        } else {
          picture = await WindowCatalog.thumbnail(display: Displays.underCursor())
        }
        guard let model, model.targets.indices.contains(index), model.targets[index].id == choice.id else { return }
        model.targets[index].thumbnail = picture
      }
    }
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
