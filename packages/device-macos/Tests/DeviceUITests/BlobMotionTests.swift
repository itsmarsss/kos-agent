import CoreGraphics
import Testing

@testable import DeviceUI

/// KOS's blob moves as the dashboard's does: it blinks, breathes, follows the pointer, and answers a poke.
@Suite("Blob motion")
struct BlobMotionTests {
  /// Steps a blob at 60 frames a second for `seconds`, keeping every frame.
  private func run(_ blob: inout BlobMotion, from start: Double, seconds: Double, pointer: CGVector? = nil) -> [BlobFrame] {
    stride(from: 0.0, to: seconds, by: 1.0 / 60).map { t in blob.step(now: start + t, dt: 1.0 / 60, pointer: pointer) }
  }

  @Test func blinksAndBreathesOnItsOwn() {
    var blob = BlobMotion(now: 0)
    let frames = run(&blob, from: 0, seconds: 10)
    let blinked = frames.contains { $0.open < 0.3 }
    #expect(blinked)
    let heights = frames.map { $0.scaleY }
    let range = (heights.max() ?? 0) - (heights.min() ?? 0)
    #expect(range > 0.02)
  }

  @Test func looksTowardThePointer() {
    var blob = BlobMotion(now: 0)
    let right = run(&blob, from: 0, seconds: 1, pointer: CGVector(dx: 200, dy: 0)).last!
    #expect(right.lookX > 2.5)
    let below = run(&blob, from: 1, seconds: 1, pointer: CGVector(dx: 0, dy: 200)).last!
    #expect(below.lookY > 1.8)
  }

  @Test func squashesUnderThePointerAndIsPleasedWhenPoked() {
    var blob = BlobMotion(now: 0)
    blob.hover = true
    let squashed = run(&blob, from: 0, seconds: 1.5).last!
    #expect(squashed.scaleX > 1.04)
    blob.poke(now: 1.5)
    let poked = run(&blob, from: 1.5, seconds: 0.3)
    let pleased = poked.allSatisfy { $0.happy }
    let wobbled = poked.contains { abs($0.skew) > 0.3 }
    let after = run(&blob, from: 3.2, seconds: 0.1).allSatisfy { !$0.happy }
    #expect(pleased)
    #expect(wobbled)
    #expect(after)
  }

  @Test func saysHowItIsByItsMood() {
    var blob = BlobMotion(now: 0)
    blob.mood = .error
    let sagging = run(&blob, from: 0, seconds: 2).last!
    #expect(sagging.open < 0.2)
    #expect(sagging.lift == 4)
    blob.mood = .needsYou
    let lowest = run(&blob, from: 2, seconds: 2).map { $0.lift }.min() ?? 0
    #expect(lowest < -5)
  }

  @Test func keepsItsOutlineSmoothAndSized() {
    let rest = BlobMotion.outline()
    #expect(rest.count == BlobMotion.points)
    let xs = rest.map { $0.x }
    let width = (xs.max() ?? 0) - (xs.min() ?? 0)
    #expect(width > 75 && width < 90)
  }
}
