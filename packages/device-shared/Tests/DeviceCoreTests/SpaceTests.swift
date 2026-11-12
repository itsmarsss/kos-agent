import Foundation
import Testing
@testable import DeviceCore

@Suite("Session coordinates")
struct SpaceTests {
  /// A 14-inch MacBook Pro at its default scaling.
  let laptop = Rect(x: 0, y: 0, width: 1512, height: 982)

  @Test func scalesTheLongSideDownToMaxEdge() {
    let space = Space(display: laptop, maxEdge: 1280)
    #expect(space.size == Size(width: 1280, height: 831))
  }

  @Test func neverScalesUp() {
    let small = Rect(x: 0, y: 0, width: 1024, height: 768)
    #expect(Space(display: small, maxEdge: 1280).size == Size(width: 1024, height: 768))
  }

  @Test func aPointInThePictureIsThePointOnTheScreen() {
    let space = Space(display: laptop, maxEdge: 1280)
    let corner = space.toGlobal(Point(x: 1280, y: 831))
    #expect(abs(corner.x - 1512) < 0.001)
    #expect(abs(corner.y - 982) < 0.001)
    let middle = space.toGlobal(Point(x: 640, y: 415.5))
    #expect(abs(middle.x - 756) < 0.001)
    #expect(abs(middle.y - 491) < 0.001)
  }

  @Test func mapsBackForTheCursor() {
    let space = Space(display: laptop, maxEdge: 1280)
    let back = space.fromGlobal(space.toGlobal(Point(x: 300, y: 200)))
    #expect(back == Point(x: 300, y: 200))
  }

  @Test func aSecondDisplayIsOffsetInGlobalSpace() {
    // An external display to the left of the main one, as macOS lays it out.
    let external = Rect(x: -1920, y: -200, width: 1920, height: 1080)
    let space = Space(display: external, maxEdge: 1280)
    #expect(space.size == Size(width: 1280, height: 720))
    let origin = space.toGlobal(Point(x: 0, y: 0))
    #expect(origin == Point(x: -1920, y: -200))
  }

  @Test func refusesPointsOffTheScreen() throws {
    let space = Space(display: laptop, maxEdge: 1280)
    #expect(try space.validate(Point(x: 0, y: 0)) == Point(x: 0, y: 0))
    #expect(throws: DeviceError.self) { try space.validate(Point(x: 1280, y: 10)) }
    #expect(throws: DeviceError.self) { try space.validate(Point(x: -1, y: 10)) }
    #expect(throws: DeviceError.self) { try space.validate(Point(x: .nan, y: 10)) }
    #expect(throws: DeviceError.self) { try space.validate(Point(x: .infinity, y: 10)) }
  }

  @Test func aRegionIsTheRightPartOfTheDisplay() throws {
    let space = Space(display: laptop, maxEdge: 1280)
    let region = try space.regionToGlobal(Rect(x: 640, y: 0, width: 640, height: 415.5))
    #expect(abs(region.x - 756) < 0.001)
    #expect(abs(region.width - 756) < 0.001)
    #expect(abs(region.height - 491) < 0.001)
  }

  @Test func aRegionIsClippedToTheScreenAndMustOverlapIt() throws {
    let space = Space(display: laptop, maxEdge: 1280)
    let clipped = try space.regionToGlobal(Rect(x: 1200, y: 800, width: 500, height: 500))
    #expect(clipped.maxX <= 1512.001)
    #expect(clipped.maxY <= 982.001)
    #expect(throws: DeviceError.self) { try space.regionToGlobal(Rect(x: 2000, y: 0, width: 10, height: 10)) }
    #expect(throws: DeviceError.self) { try space.regionToGlobal(Rect(x: 0, y: 0, width: 0, height: 10)) }
  }

  @Test func aRegionCaptureKeepsItsDetailUpToMaxEdge() {
    // A quarter of the screen on a Retina display: full detail fits.
    let small = Space.captureSize(of: Rect(x: 0, y: 0, width: 300, height: 200), backingScale: 2, maxEdge: 1280)
    #expect(small == Size(width: 600, height: 400))
    // Most of the screen: scaled down to the edge.
    let large = Space.captureSize(of: Rect(x: 0, y: 0, width: 1000, height: 500), backingScale: 2, maxEdge: 1280)
    #expect(large == Size(width: 1280, height: 640))
  }
}

@Suite("A window's space")
struct WindowSpaceTests {
  @Test func keepsItsCoordinatesWhenTheWindowMoves() {
    let window = Space(display: Rect(x: 200, y: 100, width: 800, height: 600))
    let moved = window.moved(to: Rect(x: 500, y: 300, width: 800, height: 600))
    #expect(moved.size == window.size)
    #expect(moved.toGlobal(Point(x: 10, y: 20)) == Point(x: 510, y: 320))
  }

  @Test func scalesWithTheWindowWhenItIsResized() {
    let window = Space(display: Rect(x: 0, y: 0, width: 800, height: 600))
    let wider = window.moved(to: Rect(x: 0, y: 0, width: 1600, height: 1200))
    // The middle of the picture is still the middle of the window.
    #expect(wider.toGlobal(Point(x: 400, y: 300)) == Point(x: 800, y: 600))
  }

  @Test func aSessionFollowsItsWindow() throws {
    var sessions = Sessions()
    try sessions.ask("s1", from: "kos")
    let start = Rect(x: 100, y: 100, width: 640, height: 480)
    _ = try sessions.grant(
      "s1", task: "t", requester: "r", minutes: 5, target: .window(id: 7, pid: 42, app: "Notes", title: "List"),
      space: Space(display: start), now: Date())
    sessions.follow(Rect(x: 300, y: 100, width: 640, height: 480))
    #expect(sessions.live?.space.toGlobal(Point(x: 0, y: 0)) == Point(x: 300, y: 100))
    #expect(sessions.live?.target.info == .window(app: "Notes", title: "List"))
  }
}
