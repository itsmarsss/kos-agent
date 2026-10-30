import CoreGraphics
import Foundation

/// KOS's blob as a creature, the same model the dashboard runs
/// (packages/ui/src/blob.ts), so KOS moves the same on a Mac as on the page.
///
/// It breathes, stands on a spring that hovers squash and pokes push, rings
/// like jelly when poked or when it fidgets of its own accord, glances about
/// or follows the pointer, and blinks when it feels like it. Pure state
/// stepped once a frame; the view only draws what it says.

public enum BlobMood: Equatable, Sendable {
  case idle, working, needsYou, error, asleep
}

/// KOS's own look from packages/shared: its silhouette, gait and habits.
public enum KOSLook {
  public static let aspect: Double = 1.05
  public static let squat: Double = 0
  public static let spread: Double = 0.9306
  /// The lively gait: breath in seconds, spring stiffness, how fast a wobble dies, seconds between fidgets.
  public static let breath: Double = 4
  public static let spring: Double = 420
  public static let settle: Double = 4
  public static let fidget: Double = 4
  public static let curiosity: Double = 1.11
  public static let blinkiness: Double = 1.23
  public static let seed: UInt32 = 1_912_356_932
}

/// A frame of the blob, in the 100-unit box its outline lives in.
public struct BlobFrame: Equatable, Sendable {
  public var outline: [CGPoint]
  /// The whole body: moved, scaled and skewed about the centre.
  public var lean: Double
  public var lift: Double
  public var scaleX: Double
  public var scaleY: Double
  public var skew: Double
  /// The eyes: where they look, how open and how big, and whether they smile.
  public var lookX: Double
  public var lookY: Double
  public var open: Double
  public var wide: Double
  public var happy: Bool
  public var slant: Double
}

private struct MoodSpec {
  let speed: Double
  let open: Double
  let wide: Double
  let look: Look
  let hop: Bool
  let sway: Double
  let droop: Double

  enum Look { case pointer, dart, straight }

  static func of(_ mood: BlobMood) -> MoodSpec {
    switch mood {
    case .idle: return MoodSpec(speed: 1, open: 1, wide: 1, look: .pointer, hop: false, sway: 0, droop: 0)
    case .working: return MoodSpec(speed: 1.8, open: 0.92, wide: 0.95, look: .dart, hop: false, sway: 1.6, droop: 0)
    case .needsYou: return MoodSpec(speed: 1.4, open: 1, wide: 1.25, look: .pointer, hop: true, sway: 0, droop: 0)
    case .error: return MoodSpec(speed: 0.6, open: 0.16, wide: 1, look: .straight, hop: false, sway: 0, droop: 4)
    case .asleep: return MoodSpec(speed: 0.45, open: 0.08, wide: 1, look: .straight, hop: false, sway: 0, droop: 1)
    }
  }
}

public struct BlobMotion {
  public static let center = CGPoint(x: 50, y: 52)
  public static let radius: Double = 38
  public static let points = 16
  /// Where the eyes rest, before the spread.
  public static let eyeLeft = CGPoint(x: 41, y: 48)
  public static let eyeRight = CGPoint(x: 59, y: 48)

  public var mood: BlobMood = .idle {
    didSet {
      guard mood != oldValue else { return }
      // A change of mood is felt: a small start and a wobble.
      vy -= 1.2
      vx += 1.2
      wv += 0.8
    }
  }
  public var hover = false {
    didSet { if hover && !oldValue { vy -= 0.8 } }
  }

  private var random: SplitMix
  private let t0: TimeInterval
  private var sx = 1.0, sy = 1.0, vx = 0.0, vy = 0.0
  private var wob = 0.0, wv = 0.0, wobPhase: Double
  private var nextFidget: TimeInterval
  private var lookX = 0.0, lookY = 0.0, aimX = 0.0, aimY = 0.0
  private var nextAim: TimeInterval
  private var nextBlink: TimeInterval
  private var blinkAt: TimeInterval = -1
  private var happyUntil: TimeInterval = 0

  public init(now: TimeInterval, seed: UInt32 = KOSLook.seed) {
    var random = SplitMix(seed: UInt64(seed))
    // Started somewhere along its breath, so two blobs never breathe in step.
    t0 = now - random.next() * 60
    wobPhase = random.next() * .pi
    nextFidget = now + KOSLook.fidget * random.next()
    nextAim = now + 1 + random.next() * 3
    nextBlink = now + 1.5 + random.next() * 3
    self.random = random
  }

  /// A poke: it wobbles like jelly, and is pleased about it for a moment.
  public mutating func poke(now: TimeInterval) {
    vx += 2.6
    vy -= 2.6
    wv += 2.4
    wobPhase = random.next() * .pi
    happyUntil = now + 1.6
  }

  /// One frame. `pointer` is where the pointer is from the face's centre, in points, when it moved lately.
  public mutating func step(now: TimeInterval, dt rawDt: Double, pointer: CGVector?) -> BlobFrame {
    let dt = min(0.05, max(0.001, rawDt))
    let spec = MoodSpec.of(mood)
    let t = (now - t0) * spec.speed
    let happy = now < happyUntil

    // Breathing: a little taller then a little wider, the way a soft thing breathes.
    let br = sin(t * .pi * 2 / KOSLook.breath)
    let breathX = 1 - 0.012 * br
    let breathY = 1 + 0.022 * br

    // The body: a spring toward how it wants to stand, pushed by hovers and pokes.
    var tx = 1.0, ty = 1.0, hop = 0.0
    if hover {
      tx = 1.08
      ty = 0.92
    }
    if spec.hop {
      hop = -7 * max(0, sin(t * .pi * 2 / 1.1))
      let land = max(0, -sin(t * .pi * 2 / 1.1))
      tx += 0.1 * land
      ty -= 0.1 * land
    }
    if mood == .error {
      tx = 1.05
      ty = 0.88
    }
    let damp = exp(-dt * 8)
    vx = (vx + (tx - sx) * 160 * dt) * damp
    vy = (vy + (ty - sy) * 160 * dt) * damp
    sx += vx * dt
    sy += vy * dt

    // The jelly: a wobble that rings and settles, started by a poke, a mood, or a fidget.
    if now > nextFidget && mood != .asleep && mood != .error {
      wv += 0.5 + random.next() * 0.4
      wobPhase = random.next() * .pi
      nextFidget = now + KOSLook.fidget * (0.6 + random.next() * 0.8) / (mood == .working ? 1.6 : 1)
    }
    wv = (wv - wob * KOSLook.spring * dt) * exp(-dt * KOSLook.settle)
    wob += wv * dt

    // Where to look: the pointer when it is about, a drift of its own when not.
    var lean = spec.sway * sin(t * 2.2)
    if spec.look == .straight {
      aimX = 0
      aimY = 0
    } else if spec.look == .pointer, let pointer {
      let dist = max(hypot(pointer.dx, pointer.dy), 1)
      let reach = min(1, dist / 90) * KOSLook.curiosity
      aimX = pointer.dx / dist * 3.2 * reach
      aimY = pointer.dy / dist * 2.4 * reach
      lean += pointer.dx / dist * 2.5 * max(0, 1 - dist / 160) * KOSLook.curiosity
    } else if now > nextAim {
      // A glance of its own: working, it darts about; idle, it wanders, a little up.
      let dart = spec.look == .dart
      aimX = (random.next() * 2 - 1) * (dart ? 3 : 2.4)
      aimY = (random.next() * 2 - 1) * (dart ? 2.2 : 1.4) - (dart ? 0 : 0.8)
      nextAim = now + (dart ? 0.5 + random.next() * 0.7 : 2.5 + random.next() * 4.5)
    }
    let ease = 1 - exp(-dt * (spec.look == .dart ? 14 : 9))
    lookX += (aimX - lookX) * ease
    lookY += (aimY - lookY) * ease

    // Blinks: now and then, sometimes twice; never while asleep, which is one long blink.
    var blink = 1.0
    if mood != .asleep && !happy {
      if blinkAt < 0 && now >= nextBlink { blinkAt = now }
      if blinkAt >= 0 {
        let p = (now - blinkAt) / 0.15
        if p >= 1 {
          blinkAt = -1
          nextBlink = now + (random.next() < 0.25 ? 0.22 : (2.5 + random.next() * 4) / KOSLook.blinkiness)
        } else {
          blink = 1 - 0.92 * sin(p * .pi)
        }
      }
    }
    let wobble = min(0.14, max(-0.14, wob))
    return BlobFrame(
      outline: Self.outline(wobble: wobble, phase: wobPhase),
      lean: lean,
      lift: hop + spec.droop,
      scaleX: sx * breathX,
      scaleY: sy * breathY,
      skew: wob * 18,
      lookX: lookX,
      lookY: lookY,
      open: min(1.3, max(0.06, spec.open * blink)),
      wide: spec.wide * (hover ? 1.08 : 1),
      happy: happy,
      slant: mood == .error ? 18 : 0)
  }

  /// The silhouette: a gumdrop a touch wider low down, bent by a two-lobed wobble.
  public static func outline(wobble: Double = 0, phase: Double = 0) -> [CGPoint] {
    (0..<points).map { i in
      let a = Double(i) / Double(points) * .pi * 2
      let down = max(0, sin(a))
      let r = radius * (1 + wobble * cos(2 * (a - phase)))
      return CGPoint(
        x: center.x + cos(a) * r * KOSLook.aspect * (1 + 0.07 * down),
        y: center.y + sin(a) * r * (1 - KOSLook.squat * 0.45 * down))
    }
  }

  /// Where an eye sits, spread from the middle as KOS's shape says.
  public static func eye(_ base: CGPoint) -> CGPoint {
    CGPoint(x: center.x + (base.x - center.x) * KOSLook.spread, y: base.y)
  }
}

/// A small seeded generator, so KOS's whims are its own and a test can repeat them.
struct SplitMix {
  private var state: UInt64

  init(seed: UInt64) {
    state = seed
  }

  /// A number in 0..<1.
  mutating func next() -> Double {
    state &+= 0x9E37_79B9_7F4A_7C15
    var z = state
    z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
    z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
    z ^= z >> 31
    return Double(z >> 11) / Double(1 << 53)
  }
}
