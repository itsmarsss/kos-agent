import AppKit

/// The bar at the top of the screen: KOS is using this Mac, for what, with Pause and Stop.
///
/// A non-activating panel, so pressing its buttons never takes focus from
/// the app KOS is working in. It keeps out of KOS's way: before KOS points
/// anywhere under it, the bar moves to the other edge of the screen.
@MainActor
final class HUDPanel: NSPanel {
  var onPause: (() -> Void)?
  var onResume: (() -> Void)?
  var onStop: (() -> Void)?

  private let dot = CALayer()
  private let headline = NSTextField(labelWithString: "")
  private let detail = NSTextField(labelWithString: "")
  private let pauseButton = HUDButton(title: "Pause", target: nil, action: nil)
  private let stopButton = HUDButton(title: "Stop", target: nil, action: nil)
  private let screenFrame: CGRect
  private let visibleFrame: CGRect
  private var paused = false
  private(set) var atBottom = false

  private static let height: CGFloat = 46
  private static let margin: CGFloat = 10

  init(screen: NSScreen, task text: String) {
    screenFrame = screen.frame
    visibleFrame = screen.visibleFrame
    super.init(contentRect: CGRect(x: 0, y: 0, width: 420, height: Self.height), styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: false)
    isFloatingPanel = true
    becomesKeyOnlyIfNeeded = true
    hidesOnDeactivate = false
    isOpaque = false
    backgroundColor = .clear
    hasShadow = true
    isReleasedWhenClosed = false
    level = NSWindow.Level(rawValue: NSWindow.Level.screenSaver.rawValue + 1)
    collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    sharingType = .none
    appearance = NSAppearance(named: .darkAqua)
    build(task: text)
    place(bottom: false, animated: false)
  }

  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }

  func setPaused(_ paused: Bool) {
    self.paused = paused
    headline.stringValue = paused ? "Paused. You have control." : "KOS is using this Mac"
    pauseButton.title = paused ? "Resume" : "Pause"
    dot.backgroundColor = (paused ? Palette.amber : Palette.accent).cgColor
    if paused { dot.removeAnimation(forKey: "pulse") } else { dot.add(Self.pulse(), forKey: "pulse") }
    resize()
  }

  /// Moves to the other edge when `global` (top-left origin) falls under the bar or near it.
  /// True when it moved, so the caller can let the move land before pointing there.
  func dodge(_ global: CGPoint) -> Bool {
    let mine = Displays.cocoa(frame).insetBy(dx: -24, dy: -24)
    guard mine.contains(global) else { return false }
    place(bottom: !atBottom, animated: true)
    return true
  }

  // MARK: Layout

  private func build(task text: String) {
    let effect = NSVisualEffectView()
    effect.material = .hudWindow
    effect.blendingMode = .behindWindow
    effect.state = .active
    effect.maskImage = Self.pill(radius: Self.height / 2)
    effect.wantsLayer = true
    effect.layer?.cornerRadius = Self.height / 2
    effect.layer?.borderWidth = 1
    effect.layer?.borderColor = Palette.accent.withAlphaComponent(0.55).cgColor

    let dotView = NSView(frame: CGRect(x: 0, y: 0, width: 10, height: 10))
    dotView.wantsLayer = true
    dot.frame = dotView.bounds
    dot.cornerRadius = 5
    dotView.layer?.addSublayer(dot)
    dotView.widthAnchor.constraint(equalToConstant: 10).isActive = true
    dotView.heightAnchor.constraint(equalToConstant: 10).isActive = true

    headline.font = .systemFont(ofSize: 12.5, weight: .semibold)
    headline.textColor = .white
    detail.stringValue = text
    detail.font = .systemFont(ofSize: 11)
    detail.textColor = NSColor.white.withAlphaComponent(0.7)
    detail.lineBreakMode = .byTruncatingTail
    detail.maximumNumberOfLines = 1
    detail.widthAnchor.constraint(lessThanOrEqualToConstant: 300).isActive = true
    let words = NSStackView(views: [headline, detail])
    words.orientation = .vertical
    words.alignment = .leading
    words.spacing = 1

    pauseButton.target = self
    pauseButton.action = #selector(pauseOrResume)
    stopButton.target = self
    stopButton.action = #selector(stop)
    stopButton.bezelColor = Palette.stop
    for button in [pauseButton, stopButton] {
      button.bezelStyle = .rounded
      button.controlSize = .small
      button.font = .systemFont(ofSize: 11, weight: .medium)
    }

    let row = NSStackView(views: [dotView, words, pauseButton, stopButton])
    row.orientation = .horizontal
    row.alignment = .centerY
    row.spacing = 12
    row.edgeInsets = NSEdgeInsets(top: 0, left: 18, bottom: 0, right: 12)
    row.setCustomSpacing(16, after: words)
    row.translatesAutoresizingMaskIntoConstraints = false
    effect.addSubview(row)
    NSLayoutConstraint.activate([
      row.leadingAnchor.constraint(equalTo: effect.leadingAnchor),
      row.trailingAnchor.constraint(equalTo: effect.trailingAnchor),
      row.centerYAnchor.constraint(equalTo: effect.centerYAnchor),
    ])
    contentView = effect
    setPaused(false)
  }

  private func resize() {
    guard let content = contentView else { return }
    content.layoutSubtreeIfNeeded()
    let width = min(max(content.fittingSize.width, 300), 560)
    setContentSize(CGSize(width: width, height: Self.height))
    place(bottom: atBottom, animated: false)
  }

  private func place(bottom: Bool, animated: Bool) {
    atBottom = bottom
    let y = bottom ? visibleFrame.minY + Self.margin : visibleFrame.maxY - Self.height - Self.margin
    let target = CGRect(x: screenFrame.midX - frame.width / 2, y: y, width: frame.width, height: Self.height)
    setFrame(target, display: true, animate: animated)
  }

  @objc private func pauseOrResume() {
    if paused { onResume?() } else { onPause?() }
  }

  @objc private func stop() {
    onStop?()
  }

  private static func pulse() -> CAAnimation {
    let fade = CABasicAnimation(keyPath: "opacity")
    fade.fromValue = 1
    fade.toValue = 0.35
    fade.duration = 0.9
    fade.autoreverses = true
    fade.repeatCount = .infinity
    fade.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
    return fade
  }

  /// A stretchable pill, for clipping the blurred background to the bar's shape.
  private static func pill(radius: CGFloat) -> NSImage {
    let size = CGSize(width: radius * 2 + 1, height: radius * 2)
    let image = NSImage(size: size, flipped: false) { rect in
      NSColor.black.setFill()
      NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
      return true
    }
    image.capInsets = NSEdgeInsets(top: radius, left: radius, bottom: radius, right: radius)
    image.resizingMode = .stretch
    return image
  }
}

/// A button that answers the first click, in a panel that never becomes key.
final class HUDButton: NSButton {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}
