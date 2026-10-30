import AppKit
import QuartzCore

/// KOS's cursor: an arrow in KOS's blue, larger than the system's and lit
/// from behind, with a soft halo round its tip, drawn exactly under the
/// real pointer, and a tag that says whose it is. The system's arrow sits
/// on top of it, so KOS's shows as the blue around it.
final class KOSCursor: CALayer {
  private let halo = CAShapeLayer()
  private let arrow = CAShapeLayer()
  private let tag = CALayer()
  private let label = CATextLayer()
  private var restTag: DispatchWorkItem?

  private static let scale: CGFloat = 1.5
  private static let haloRadius: CGFloat = 15
  /// The arrow's outline with its tip at (0, 0), y downward, at the system cursor's size.
  private static let outline: [CGPoint] = [
    CGPoint(x: 0, y: 0), CGPoint(x: 0, y: 17), CGPoint(x: 4.2, y: 13.3), CGPoint(x: 7, y: 19.5),
    CGPoint(x: 9.6, y: 18.4), CGPoint(x: 6.9, y: 12.3), CGPoint(x: 12.5, y: 12.3),
  ]
  private static let size = CGSize(width: 13 * scale, height: 20 * scale)

  init(contentsScale: CGFloat) {
    super.init()
    self.contentsScale = contentsScale
    bounds = CGRect(origin: .zero, size: Self.size)
    // The tip is the hot spot: top-left, in this bottom-left layer space.
    anchorPoint = CGPoint(x: 0, y: 1)

    let r = Self.haloRadius
    halo.path = CGPath(ellipseIn: CGRect(x: -r, y: Self.size.height - r, width: r * 2, height: r * 2), transform: nil)
    halo.fillColor = Palette.accent.withAlphaComponent(0.16).cgColor
    halo.strokeColor = Palette.accent.withAlphaComponent(0.55).cgColor
    halo.lineWidth = 1.2
    addSublayer(halo)

    let path = CGMutablePath()
    path.addLines(between: Self.outline.map { CGPoint(x: $0.x * Self.scale, y: Self.size.height - $0.y * Self.scale) })
    path.closeSubpath()
    arrow.path = path
    arrow.fillColor = Palette.accent.cgColor
    arrow.strokeColor = NSColor.white.cgColor
    arrow.lineWidth = 1.4
    arrow.lineJoin = .round
    arrow.shadowColor = Palette.accent.cgColor
    arrow.shadowOpacity = 0.95
    arrow.shadowRadius = 7
    arrow.shadowOffset = .zero
    addSublayer(arrow)

    label.string = "KOS"
    label.font = NSFont.systemFont(ofSize: 10, weight: .semibold)
    label.fontSize = 10
    label.foregroundColor = NSColor.white.cgColor
    label.alignmentMode = .center
    label.contentsScale = contentsScale
    tag.backgroundColor = Palette.accent.cgColor
    tag.cornerRadius = 6
    tag.shadowColor = NSColor.black.cgColor
    tag.shadowOpacity = 0.25
    tag.shadowRadius = 3
    tag.shadowOffset = CGSize(width: 0, height: -1)
    tag.addSublayer(label)
    addSublayer(tag)
    setTag("KOS")
  }

  override init(layer: Any) {
    super.init(layer: layer)
  }

  required init?(coder: NSCoder) { fatalError("not used") }

  /// Puts the tip on `point`, in the overlay's layer space, without animating: it follows each glide step.
  func move(to point: CGPoint) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    position = point
    CATransaction.commit()
  }

  func setPaused(_ paused: Bool) {
    let colour = paused ? Palette.amber : Palette.accent
    opacity = paused ? 0.5 : 1
    arrow.fillColor = colour.cgColor
    arrow.shadowColor = colour.cgColor
    halo.fillColor = colour.withAlphaComponent(0.16).cgColor
    halo.strokeColor = colour.withAlphaComponent(0.55).cgColor
    tag.backgroundColor = colour.cgColor
  }

  /// While KOS types, the tag says so; it settles back once the typing stops.
  func showTyping() {
    setTag("KOS · typing")
    restTag?.cancel()
    let rest = DispatchWorkItem { [weak self] in self?.setTag("KOS") }
    restTag = rest
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8, execute: rest)
  }

  private func setTag(_ text: String) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    label.string = text
    let width = ceil((text as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: 10, weight: .semibold)]).width) + 12
    // Below and to the right of the tip, clear of the arrow.
    tag.frame = CGRect(x: 14, y: -14, width: width, height: 16)
    label.frame = CGRect(x: 0, y: 1.5, width: width, height: 13)
    CATransaction.commit()
  }

  /// A ring that spreads from where KOS clicked; `point` is in the overlay's layer space.
  static func ripple(at point: CGPoint, in host: CALayer) {
    let ring = CAShapeLayer()
    let radius: CGFloat = 18
    ring.path = CGPath(ellipseIn: CGRect(x: -radius, y: -radius, width: radius * 2, height: radius * 2), transform: nil)
    ring.position = point
    ring.fillColor = Palette.accent.withAlphaComponent(0.18).cgColor
    ring.strokeColor = Palette.accent.cgColor
    ring.lineWidth = 2
    ring.opacity = 0
    host.addSublayer(ring)
    let grow = CABasicAnimation(keyPath: "transform.scale")
    grow.fromValue = 0.35
    grow.toValue = 1.5
    let fade = CABasicAnimation(keyPath: "opacity")
    fade.fromValue = 0.95
    fade.toValue = 0
    let group = CAAnimationGroup()
    group.animations = [grow, fade]
    group.duration = 0.45
    group.timingFunction = CAMediaTimingFunction(name: .easeOut)
    CATransaction.begin()
    CATransaction.setCompletionBlock { ring.removeFromSuperlayer() }
    ring.add(group, forKey: "ripple")
    CATransaction.commit()
  }
}
