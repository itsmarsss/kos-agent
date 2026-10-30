import AppKit

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
  private var continuation: CheckedContinuation<Answer, Never>?
  private var timer: Timer?
  private var remaining = ConsentPrompt.timeout
  private let durations = NSPopUpButton()
  private let countdown = NSTextField(labelWithString: "")
  private var offered: [Int] = []

  func ask(_ request: Request) async -> Answer {
    finish(.withdrawn)
    offered = request.offered
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
    let panel = NSPanel(
      contentRect: CGRect(x: 0, y: 0, width: 380, height: 300),
      styleMask: [.titled, .nonactivatingPanel, .fullSizeContentView], backing: .buffered, defer: false)
    panel.titleVisibility = .hidden
    panel.titlebarAppearsTransparent = true
    panel.isMovableByWindowBackground = true
    panel.isFloatingPanel = true
    panel.hidesOnDeactivate = false
    panel.level = NSWindow.Level(rawValue: NSWindow.Level.screenSaver.rawValue + 2)
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.isReleasedWhenClosed = false
    let view = content(for: request)
    panel.contentView = view
    panel.setContentSize(view.fittingSize)
    if let screen = Displays.screen(for: Displays.underCursor()) {
      let size = panel.frame.size
      panel.setFrameOrigin(CGPoint(x: screen.visibleFrame.midX - size.width / 2, y: screen.visibleFrame.midY - size.height / 2 + 80))
    }
    panel.makeKeyAndOrderFront(nil)
    self.panel = panel
    NSSound(named: "Glass")?.play()

    remaining = Self.timeout
    updateCountdown()
    timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.tick() }
    }
  }

  private func content(for request: Request) -> NSView {
    let icon = NSImageView(image: NSImage(systemSymbolName: "cursorarrow.rays", accessibilityDescription: nil) ?? NSImage())
    icon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 30, weight: .medium)
    icon.contentTintColor = Palette.accent

    let title = NSTextField(labelWithString: "KOS wants to use this Mac")
    title.font = .systemFont(ofSize: 16, weight: .semibold)
    let asker = NSTextField(labelWithString: "Asked from \(request.requester)")
    asker.font = .systemFont(ofSize: 12)
    asker.textColor = .secondaryLabelColor

    let task = NSTextField(wrappingLabelWithString: request.task)
    task.font = .systemFont(ofSize: 13)
    task.maximumNumberOfLines = 5
    task.lineBreakMode = .byTruncatingTail
    task.preferredMaxLayoutWidth = 316
    let taskBox = NSBox()
    taskBox.boxType = .custom
    taskBox.cornerRadius = 8
    taskBox.borderColor = Palette.accent.withAlphaComponent(0.35)
    taskBox.fillColor = Palette.accent.withAlphaComponent(0.08)
    taskBox.contentViewMargins = NSSize(width: 10, height: 8)
    taskBox.contentView = task

    let note = NSTextField(wrappingLabelWithString:
      "It will see this screen and use the mouse and keyboard. Touch either to pause it. It never types into password fields or sees hidden apps.")
    note.font = .systemFont(ofSize: 11)
    note.textColor = .secondaryLabelColor
    note.preferredMaxLayoutWidth = 336

    durations.removeAllItems()
    durations.addItems(withTitles: request.offered.map { "\($0) minutes" })
    durations.selectItem(at: request.offered.count - 1)
    let forLabel = NSTextField(labelWithString: "Allow for")
    forLabel.font = .systemFont(ofSize: 12)
    let length = NSStackView(views: [forLabel, durations])
    length.spacing = 8

    countdown.font = .systemFont(ofSize: 11)
    countdown.textColor = .tertiaryLabelColor

    let deny = NSButton(title: "Deny", target: self, action: #selector(denied))
    deny.keyEquivalent = "\u{1b}"
    let allow = NSButton(title: "Allow", target: self, action: #selector(allowed))
    allow.keyEquivalent = "\r"
    allow.bezelColor = Palette.accent
    let buttons = NSStackView(views: [countdown, NSView(), deny, allow])
    buttons.spacing = 8

    let stack = NSStackView(views: [icon, title, asker, taskBox, note, length, buttons])
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 10
    stack.setCustomSpacing(2, after: title)
    stack.setCustomSpacing(14, after: asker)
    stack.setCustomSpacing(16, after: length)
    stack.edgeInsets = NSEdgeInsets(top: 30, left: 22, bottom: 20, right: 22)
    for view in [taskBox, note, buttons] {
      view.translatesAutoresizingMaskIntoConstraints = false
      view.widthAnchor.constraint(equalToConstant: 336).isActive = true
    }
    return stack
  }

  @objc private func allowed() {
    let index = durations.indexOfSelectedItem
    guard let minutes = offered.indices.contains(index) ? offered[index] : offered.last else { return finish(.denied) }
    finish(.allowed(minutes: minutes))
  }

  @objc private func denied() {
    finish(.denied)
  }

  private func tick() {
    remaining -= 1
    if remaining <= 0 { finish(.unanswered) } else { updateCountdown() }
  }

  private func updateCountdown() {
    countdown.stringValue = "Declines in \(remaining) s"
  }

  private func finish(_ answer: Answer) {
    timer?.invalidate()
    timer = nil
    panel?.orderOut(nil)
    panel = nil
    let waiting = continuation
    continuation = nil
    waiting?.resume(returning: answer)
  }
}
