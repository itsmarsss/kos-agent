import AppKit

/// Small builders the windows share, so each window reads as its content.
enum Form {
  static func window(title: String, width: CGFloat) -> NSWindow {
    let window = NSWindow(
      contentRect: CGRect(x: 0, y: 0, width: width, height: 200), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.title = title
    window.isReleasedWhenClosed = false
    return window
  }

  /// Sets the window's content to `stack`, sized to fit, centred, in front.
  static func show(_ window: NSWindow, content stack: NSView) {
    window.contentView = stack
    window.setContentSize(stack.fittingSize)
    window.center()
    NSApp.activate(ignoringOtherApps: true)
    window.makeKeyAndOrderFront(nil)
  }

  static func column(_ views: [NSView], spacing: CGFloat = 12) -> NSStackView {
    let stack = NSStackView(views: views)
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = spacing
    stack.edgeInsets = NSEdgeInsets(top: 20, left: 22, bottom: 20, right: 22)
    return stack
  }

  static func heading(_ text: String) -> NSTextField {
    let label = NSTextField(labelWithString: text)
    label.font = .systemFont(ofSize: 14, weight: .semibold)
    return label
  }

  static func note(_ text: String, width: CGFloat) -> NSTextField {
    let label = NSTextField(wrappingLabelWithString: text)
    label.font = .systemFont(ofSize: 11.5)
    label.textColor = .secondaryLabelColor
    label.preferredMaxLayoutWidth = width
    return label
  }

  static func field(placeholder: String, width: CGFloat) -> NSTextField {
    let field = NSTextField()
    field.placeholderString = placeholder
    field.translatesAutoresizingMaskIntoConstraints = false
    field.widthAnchor.constraint(equalToConstant: width).isActive = true
    return field
  }

  static func labelled(_ label: String, _ control: NSView) -> NSStackView {
    let title = NSTextField(labelWithString: label)
    title.font = .systemFont(ofSize: 12, weight: .medium)
    let stack = NSStackView(views: [title, control])
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 4
    return stack
  }

  static func row(_ views: [NSView]) -> NSStackView {
    let stack = NSStackView(views: views)
    stack.orientation = .horizontal
    stack.spacing = 8
    return stack
  }

  /// Fills the rest of a row, pushing what follows to its far end.
  static func spacer() -> NSView {
    let view = NSView()
    view.setContentHuggingPriority(.defaultLow, for: .horizontal)
    return view
  }
}
