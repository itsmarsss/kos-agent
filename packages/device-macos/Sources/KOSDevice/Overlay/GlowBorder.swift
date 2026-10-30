import AppKit
import QuartzCore

/// The glowing border round the screen KOS is using.
///
/// Two layers on one path that hugs the screen's edge: a soft bloom that
/// breathes, and a crisp rim whose colour sweeps slowly round, KOS's blue
/// into violet. Paused, both turn amber and hold still, so the state reads
/// from across the room.
final class GlowBorder: CALayer {
  private let bloom = CAShapeLayer()
  private let rim = CALayer()
  private let rimMask = CAShapeLayer()
  private let sweep = CAGradientLayer()
  private let topCornerRadius: CGFloat

  private static let bloomWidth: CGFloat = 10
  private static let rimWidth: CGFloat = 3.5

  /// `topCornerRadius` follows the display's own rounded corners, so the light sits on the glass's edge.
  init(topCornerRadius: CGFloat) {
    self.topCornerRadius = topCornerRadius
    super.init()
    bloom.fillColor = nil
    bloom.lineWidth = Self.bloomWidth
    bloom.shadowOffset = .zero
    bloom.shadowRadius = 26
    bloom.shadowOpacity = 1
    rimMask.fillColor = nil
    rimMask.strokeColor = NSColor.white.cgColor
    rimMask.lineWidth = Self.rimWidth
    rim.mask = rimMask
    sweep.type = .conic
    sweep.startPoint = CGPoint(x: 0.5, y: 0.5)
    sweep.endPoint = CGPoint(x: 0.5, y: 0)
    rim.addSublayer(sweep)
    addSublayer(bloom)
    addSublayer(rim)
    setPaused(false)
  }

  override init(layer: Any) {
    topCornerRadius = (layer as? GlowBorder)?.topCornerRadius ?? 0
    super.init(layer: layer)
  }

  required init?(coder: NSCoder) { fatalError("not used") }

  override func layoutSublayers() {
    super.layoutSublayers()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    let path = Self.edgePath(in: bounds, topRadius: topCornerRadius)
    bloom.frame = bounds
    bloom.path = path
    bloom.shadowPath = path.copy(strokingWithWidth: Self.bloomWidth, lineCap: .round, lineJoin: .round, miterLimit: 0)
    rim.frame = bounds
    rimMask.frame = bounds
    rimMask.path = path
    // Wide enough to cover the screen at any angle as it turns.
    let side = hypot(bounds.width, bounds.height)
    sweep.bounds = CGRect(x: 0, y: 0, width: side, height: side)
    sweep.position = CGPoint(x: bounds.midX, y: bounds.midY)
    CATransaction.commit()
  }

  func setPaused(_ paused: Bool) {
    CATransaction.begin()
    CATransaction.setAnimationDuration(0.35)
    let colour = paused ? Palette.amber : Palette.accent
    bloom.strokeColor = colour.withAlphaComponent(0.9).cgColor
    bloom.shadowColor = colour.cgColor
    sweep.colors = paused
      ? [Palette.amber, Palette.amber].map(\.cgColor)
      : [Palette.accent, Palette.violet, Palette.accent, Palette.violet, Palette.accent].map(\.cgColor)
    CATransaction.commit()
    if paused {
      bloom.removeAnimation(forKey: "breathe")
      sweep.removeAnimation(forKey: "sweep")
      bloom.opacity = 0.85
    } else {
      bloom.add(Self.breathing(), forKey: "breathe")
      sweep.add(Self.sweeping(), forKey: "sweep")
    }
  }

  private static func breathing() -> CAAnimation {
    let opacity = CABasicAnimation(keyPath: "opacity")
    opacity.fromValue = 0.5
    opacity.toValue = 0.95
    let radius = CABasicAnimation(keyPath: "shadowRadius")
    radius.fromValue = 20
    radius.toValue = 32
    let group = CAAnimationGroup()
    group.animations = [opacity, radius]
    group.duration = 2.6
    group.autoreverses = true
    group.repeatCount = .infinity
    group.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
    return group
  }

  private static func sweeping() -> CAAnimation {
    let turn = CABasicAnimation(keyPath: "transform.rotation.z")
    turn.fromValue = 0
    turn.toValue = -2 * Double.pi
    turn.duration = 14
    turn.repeatCount = .infinity
    return turn
  }

  /// The screen's edge, a little inside it so the rim is fully on the glass; rounded only where the display is.
  private static func edgePath(in bounds: CGRect, topRadius: CGFloat) -> CGPath {
    let rect = bounds.insetBy(dx: rimWidth / 2, dy: rimWidth / 2)
    let r = min(topRadius, rect.width / 2, rect.height / 2)
    let path = CGMutablePath()
    // Layer space is bottom-left origin, so the top edge is maxY.
    path.move(to: CGPoint(x: rect.minX, y: rect.minY))
    path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY - r))
    path.addArc(tangent1End: CGPoint(x: rect.minX, y: rect.maxY), tangent2End: CGPoint(x: rect.minX + r, y: rect.maxY), radius: r)
    path.addLine(to: CGPoint(x: rect.maxX - r, y: rect.maxY))
    path.addArc(tangent1End: CGPoint(x: rect.maxX, y: rect.maxY), tangent2End: CGPoint(x: rect.maxX, y: rect.maxY - r), radius: r)
    path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
    path.closeSubpath()
    return path
  }
}
