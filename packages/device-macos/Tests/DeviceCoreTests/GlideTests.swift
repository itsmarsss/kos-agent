import Testing
@testable import DeviceCore

@Suite("Pointer glide")
struct GlideTests {
  @Test func endsExactlyOnTheTarget() {
    let glide = Glide(from: Point(x: 0, y: 0), to: Point(x: 800, y: 300))
    #expect(glide.points.last == Point(x: 800, y: 300))
    #expect(glide.interval == 1.0 / 120)
  }

  @Test func takesLongerTheFurtherItGoesWithinBounds() {
    #expect(Glide.duration(for: 0) == 0)
    #expect(Glide.duration(for: 10) >= Glide.shortest)
    #expect(Glide.duration(for: 100) < Glide.duration(for: 1000))
    #expect(abs(Glide.duration(for: 50_000) - Glide.longest) < 1e-9)
    let near = Glide(from: Point(x: 0, y: 0), to: Point(x: 20, y: 0))
    let far = Glide(from: Point(x: 0, y: 0), to: Point(x: 1500, y: 0))
    #expect(near.points.count == 18)
    #expect(far.points.count == 54)
  }

  @Test func standingStillIsOneStep() {
    let glide = Glide(from: Point(x: 5, y: 5), to: Point(x: 5, y: 5))
    #expect(glide.points == [Point(x: 5, y: 5)])
  }

  @Test func movesSteadilyForwardWithoutOvershooting() {
    let glide = Glide(from: Point(x: 0, y: 0), to: Point(x: 1000, y: 0))
    let xs = glide.points.map(\.x)
    #expect(zip(xs, xs.dropFirst()).allSatisfy { $0 <= $1 })
    #expect(xs.allSatisfy { $0 <= 1000 })
  }

  @Test func bendsOnlyAShallowArc() {
    let glide = Glide(from: Point(x: 0, y: 0), to: Point(x: 1000, y: 0))
    let deepest = glide.points.map { abs($0.y) }.max() ?? 0
    #expect(deepest > 0)
    #expect(deepest <= 40)
  }

  @Test func easesInAndOut() {
    #expect(Glide.ease(0) == 0)
    #expect(Glide.ease(1) == 1)
    #expect(abs(Glide.ease(0.5) - 0.5) < 0.0001)
    #expect(Glide.ease(0.1) < 0.1)
    #expect(Glide.ease(0.9) > 0.9)
  }
}
