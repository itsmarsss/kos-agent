import AppKit

/// The two grants, what each is for, and a way to each one's switch in System Settings.
@MainActor
final class PermissionsWindow: NSObject, NSWindowDelegate {
  @MainActor
  private struct Row {
    let kind: SystemPermissions.Kind
    let state = NSTextField(labelWithString: "")
    let button: NSButton
  }

  private let window = Form.window(title: "KOS Device permissions", width: 440)
  private var rows: [Row] = []
  private var asked: Set<String> = []
  private var timer: Timer?

  func show() {
    guard !window.isVisible else { return window.makeKeyAndOrderFront(nil) }
    window.delegate = self
    rows = [SystemPermissions.Kind.screen, .input].map { kind in
      Row(kind: kind, button: NSButton(title: "Grant…", target: self, action: #selector(grant(_:))))
    }
    var views: [NSView] = [Form.heading("Let KOS see and use this Mac")]
    for (index, row) in rows.enumerated() {
      row.button.tag = index
      row.state.font = .systemFont(ofSize: 12, weight: .medium)
      let title = NSTextField(labelWithString: row.kind.title)
      title.font = .systemFont(ofSize: 13, weight: .semibold)
      let what = Form.note(Self.purpose(row.kind), width: 300)
      let words = NSStackView(views: [title, what])
      words.orientation = .vertical
      words.alignment = .leading
      words.spacing = 2
      views.append(Form.row([words, Form.spacer(), row.state, row.button]))
    }
    views.append(Form.note(
      "KOS can only use them during a session you allowed, with the border on screen. After granting Screen Recording, macOS may ask to reopen KOS Device.",
      width: 396))
    Form.show(window, content: Form.column(views, spacing: 14))
    refresh()
    timer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.refresh() }
    }
  }

  func windowWillClose(_ notification: Notification) {
    timer?.invalidate()
    timer = nil
  }

  @objc private func grant(_ sender: NSButton) {
    let kind = rows[sender.tag].kind
    // The first press puts KOS Device in the list with macOS's own prompt; after that, straight to the switch.
    if asked.insert(kind.title).inserted {
      SystemPermissions.request(kind)
    } else {
      SystemPermissions.openSettings(kind)
    }
    refresh()
  }

  private func refresh() {
    for row in rows {
      let granted = SystemPermissions.isGranted(row.kind)
      row.state.stringValue = granted ? "Granted" : "Not granted"
      row.state.textColor = granted ? .systemGreen : .systemOrange
      row.button.isHidden = granted
      if asked.contains(row.kind.title) { row.button.title = "Open Settings" }
    }
  }

  private static func purpose(_ kind: SystemPermissions.Kind) -> String {
    switch kind {
    case .screen: return "To show KOS the screen it is working on."
    case .input: return "To move the pointer, click and type, and to notice when you take over."
    }
  }
}
