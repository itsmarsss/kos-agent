import DeviceCore
import Foundation

/// How a KOS looks, as it sent its face: the colours, the eyes, the gait and
/// the outline, all decided in KOS (packages/shared face.ts), so this app
/// draws it without repeating the hash. A KOS that has sent none looks as
/// KOS does with nothing set.
public struct FaceLook: Equatable, Sendable {
  public enum Eyes: String, Sendable {
    case round, half, sparkle
  }

  /// One set of gentle bulges round the body: `k` of them, each `amp` of the radius out, the set turned `phase` radians.
  public struct Lobe: Equatable, Sendable {
    public var k: Int
    public var amp: Double
    public var phase: Double

    public init(k: Int, amp: Double, phase: Double) {
      self.k = k
      self.amp = amp
      self.phase = phase
    }
  }

  /// Wider or taller, sat squat or standing round, eyes close or wide, and lumpy its own way.
  public struct Shape: Equatable, Sendable {
    public var aspect: Double
    public var squat: Double
    public var spread: Double
    public var lobes: [Lobe]

    public init(aspect: Double, squat: Double, spread: Double, lobes: [Lobe]) {
      self.aspect = aspect
      self.squat = squat
      self.spread = spread
      self.lobes = lobes
    }
  }

  public var fill: UInt32
  public var ink: UInt32
  public var eyes: Eyes
  /// Which of the four gaits, 0 to 3: steady, lively, slow, restless.
  public var gait: Int
  public var shape: Shape

  public init(fill: UInt32, ink: UInt32, eyes: Eyes, gait: Int, shape: Shape) {
    self.fill = fill
    self.ink = ink
    self.eyes = eyes
    self.gait = min(max(gait, 0), Gait.all.count - 1)
    self.shape = shape
  }

  /// KOS's own face with nothing set, as @kos/shared decides it.
  public static let kos = FaceLook(
    fill: 0x3585ED, ink: 0x141D29, eyes: .half, gait: 1, shape: Shape(aspect: 1.05, squat: 0, spread: 0.9306, lobes: []))
}

/// How a blob moves: seconds per breath, how stiff its spring, how fast a
/// wobble dies, seconds between fidgets (GAITS in packages/shared blobmotion.ts).
public struct Gait: Equatable, Sendable {
  public let breath: Double
  public let spring: Double
  public let settle: Double
  public let fidget: Double

  public static let all = [
    Gait(breath: 5.5, spring: 320, settle: 5, fidget: 7),  // steady
    Gait(breath: 4, spring: 420, settle: 4, fidget: 4),  // lively
    Gait(breath: 7, spring: 240, settle: 6, fidget: 10),  // slow
    Gait(breath: 3.4, spring: 520, settle: 3.5, fidget: 2.5),  // restless
  ]
}

extension FaceLook {
  /// A face as a KOS sent it, drawn; KOS's own where a part does not read.
  public init(_ drawing: FaceDrawing) {
    self.init(
      fill: FaceDrawing.rgb(drawing.fill) ?? FaceLook.kos.fill,
      ink: FaceDrawing.rgb(drawing.ink) ?? FaceLook.kos.ink,
      eyes: Eyes(rawValue: drawing.eyes) ?? FaceLook.kos.eyes,
      gait: drawing.gait,
      shape: Shape(
        aspect: drawing.shape.aspect, squat: drawing.shape.squat, spread: drawing.shape.spread,
        lobes: drawing.shape.lobes.map { Lobe(k: $0.k, amp: $0.amp, phase: $0.phase) }))
  }
}
