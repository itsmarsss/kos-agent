import AppKit
import SwiftUI
import Testing

@testable import DeviceUI

/// The overlay thumb (OverlayScroll.swift): where it sits, when it shows and takes a press, that it takes no
/// lane, and that a drag on it moves the page.
@MainActor
@Suite("Overlay scroll")
struct OverlayScrollTests {
  @Test func noThumbWhenThePageFits() {
    #expect(ThumbBar(offset: 0, content: 300, visible: 300) == nil)
    #expect(ThumbBar(offset: 0, content: 300.5, visible: 300) == nil)
    // A view too short for even the shortest thumb has none.
    #expect(ThumbBar(offset: 0, content: 900, visible: 29) == nil)
  }

  @Test func theThumbIsAsLongAsTheShareShowing() throws {
    let bar = try #require(ThumbBar(offset: 0, content: 1000, visible: 500))
    #expect(bar.size == 249)
    #expect(bar.top == ThumbBar.inset)
  }

  @Test func theThumbRunsTheTrackAndStopsAtItsEnds() throws {
    let end = try #require(ThumbBar(offset: 500, content: 1000, visible: 500))
    #expect(end.top + end.size == 500 - ThumbBar.inset)
    let past = try #require(ThumbBar(offset: 900, content: 1000, visible: 500))
    #expect(past.top == end.top)
    let above = try #require(ThumbBar(offset: -40, content: 1000, visible: 500))
    #expect(above.top == ThumbBar.inset)
    // A drag the length of the track's free run moves the page its whole span.
    #expect(abs(end.ratio * (498 - end.size) - 500) < 0.001)
  }

  @Test func aLongPageStillHasAThumbToGrab() throws {
    let bar = try #require(ThumbBar(offset: 0, content: 100_000, visible: 400))
    #expect(bar.size == ThumbBar.minimum)
  }

  /// A page 1000 tall in a view 200 by 300: its thumb is 89 long, from 1 down at the top.
  private func track(fade: Duration = .seconds(60)) -> ScrollTrack {
    let track = ScrollTrack()
    track.fade = fade
    track.measure(size: CGSize(width: 200, height: 300))
    track.measure(offset: 0, content: 1000)
    return track
  }

  @Test func nearTheEdgeShowsTheThumbAndOnItTheThumbTakesThePress() {
    let track = track()
    track.hover(CGPoint(x: 100, y: 20))
    #expect(!track.near && !track.grab && !track.shown)
    // Within 8 of the edge, beside the thumb: shown, not pressable.
    track.hover(CGPoint(x: 193, y: 20))
    #expect(track.near && !track.grab && track.shown && !track.pressable)
    #expect(track.widen == 1)
    // On the thumb as drawn: lit, 1.6 as wide, and pressable.
    track.hover(CGPoint(x: 197, y: 20))
    #expect(track.grab && track.lit && track.pressable)
    #expect(track.widen == 1.6)
    // Level with the edge but below the thumb: near, not on it.
    track.hover(CGPoint(x: 197, y: 200))
    #expect(track.near && !track.grab)
    track.hover(nil)
    #expect(!track.near && !track.grab && !track.pressable)
  }

  @Test func thePageMovingUnderAStillPointerTakesTheGrabAway() {
    let track = track()
    track.hover(CGPoint(x: 197, y: 20))
    #expect(track.grab)
    track.userScrolled()
    track.measure(offset: 700, content: 1000)
    #expect(!track.grab, "the thumb went down the track, the pointer stayed")
    track.measure(offset: 0, content: 1000)
    #expect(track.grab)
  }

  @Test func onlyTheOwnersScrollShowsTheThumb() {
    let track = track()
    // The chat following a turn as it streams.
    track.measure(offset: 120, content: 1000)
    #expect(!track.shown)
    track.userScrolled()
    track.measure(offset: 160, content: 1000)
    #expect(track.shown)
  }

  /// Waits, up to two seconds however loaded the machine is, for the thumb to fade.
  private func faded(_ track: ScrollTrack) async throws -> Bool {
    let clock = ContinuousClock()
    let until = clock.now + .seconds(2)
    while track.shown && clock.now < until { try await Task.sleep(for: .milliseconds(10)) }
    return !track.shown
  }

  @Test func theThumbFadesOnceTheScrollingStops() async throws {
    let track = track(fade: .milliseconds(300))
    let clock = ContinuousClock()
    track.userScrolled()
    track.measure(offset: 40, content: 1000)
    #expect(track.shown)
    try await Task.sleep(for: .milliseconds(150))
    track.userScrolled()
    track.measure(offset: 80, content: 1000)
    let again = clock.now
    try await Task.sleep(for: .milliseconds(200))
    // Past the first scroll's fade, not the second's: still shown. (A machine too busy to wake in time proves nothing.)
    if clock.now - again < .milliseconds(300) { #expect(track.shown, "a scroll since put the fade back") }
    #expect(try await faded(track))
  }

  @Test func theThumbStaysWhileThePointerIsNear() async throws {
    let track = track(fade: .milliseconds(40))
    track.hover(CGPoint(x: 195, y: 200))
    try await Task.sleep(for: .milliseconds(120))
    #expect(track.shown)
    track.hover(nil)
    #expect(try await faded(track))
  }

  /// A scroll view as AppKit makes one, its page 1000 tall in a view 300 tall.
  private func scrollView(insets: NSEdgeInsets = NSEdgeInsets()) -> NSScrollView {
    let scroll = NSScrollView(frame: CGRect(x: 0, y: 0, width: 200, height: 300))
    scroll.automaticallyAdjustsContentInsets = false
    scroll.contentInsets = insets
    scroll.documentView = FlippedPage(frame: CGRect(x: 0, y: 0, width: 200, height: 1000))
    return scroll
  }

  @Test func aDragMovesThePageByTheThumbsRatio() throws {
    let track = track()
    let scroll = scrollView()
    track.scrollView = scroll
    let ratio = try #require(track.bar).ratio
    track.beginDrag()
    #expect(track.dragging && track.lit)
    track.drag(50)
    #expect(abs(scroll.contentView.bounds.minY - 50 * ratio) < 0.5)
    track.drag(10_000)
    #expect(scroll.contentView.bounds.minY == 700)
    track.drag(-10_000)
    #expect(scroll.contentView.bounds.minY == 0)
    track.endDrag()
    #expect(!track.dragging)
  }

  @Test func aDragKeepsToTheContentInsets() {
    let track = ScrollTrack()
    let scroll = scrollView(insets: NSEdgeInsets(top: 20, left: 0, bottom: 30, right: 0))
    track.scrollView = scroll
    track.scroll(to: -100)
    #expect(scroll.contentView.bounds.minY == -20)
    track.scroll(to: 10_000)
    #expect(scroll.contentView.bounds.minY == 1000 - scroll.contentView.bounds.height + 30)
  }

  /// The page drawn in a window, as the app draws it, over the track given.
  private func host(_ track: ScrollTrack, height: CGFloat) throws -> (NSView, NSScrollView) {
    let view = OverlayScroll(track: track) { Color.black.frame(height: height) }.frame(width: 200, height: 300).background(Color.black)
    let host = window(view, width: 200, height: 300)
    return (host, try #require(Self.scrollView(in: host)))
  }

  private func window<V: View>(_ view: V, width: CGFloat, height: CGFloat) -> NSView {
    let host = NSHostingView(rootView: view)
    host.frame = CGRect(x: 0, y: 0, width: width, height: height)
    let window = NSWindow(contentRect: host.frame, styleMask: .borderless, backing: .buffered, defer: false)
    window.appearance = NSAppearance(named: .darkAqua)
    window.contentView = host
    host.layoutSubtreeIfNeeded()
    return host
  }

  static func scrollView(in view: NSView) -> NSScrollView? {
    if let scroll = view as? NSScrollView { return scroll }
    return view.subviews.lazy.compactMap { scrollView(in: $0) }.first
  }

  /// The colour of the window at a point (in points from its top left).
  private func colour(_ host: NSView, x: CGFloat, y: CGFloat) throws -> NSColor {
    let rep = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
    host.cacheDisplay(in: host.bounds, to: rep)
    let scale = CGFloat(rep.pixelsWide) / host.bounds.width
    return try #require(rep.colorAt(x: Int(x * scale), y: Int(y * scale))?.usingColorSpace(.sRGB))
  }

  private func brightness(_ host: NSView, x: CGFloat, y: CGFloat) throws -> CGFloat {
    try colour(host, x: x, y: y).brightnessComponent
  }

  private func settle(_ host: NSView) {
    for _ in 0..<5 {
      RunLoop.main.run(until: Date().addingTimeInterval(0.03))
      host.layoutSubtreeIfNeeded()
    }
  }

  @Test func thePageTakesTheWholeWidthEvenWithTheLegacyScroller() throws {
    let (host, scroll) = try host(ScrollTrack(), height: 2000)
    // As a Mac with a mouse, or "Show scroll bars: Always", has it.
    scroll.scrollerStyle = .legacy
    scroll.tile()
    settle(host)
    #expect(scroll.scrollerStyle == .legacy)
    // The legacy scroller's lane would leave the page 15 short of the view.
    #expect(scroll.contentView.bounds.width == 200)
    #expect(!scroll.hasVerticalScroller || scroll.verticalScroller?.isHidden != false)
  }

  @Test func aScrollTheAppMakesMovesNoThumbButTheOwnersShowsIt() throws {
    let track = track()
    let (host, scroll) = try host(track, height: 1200)
    settle(host)
    #expect(try brightness(host, x: 197.5, y: 150) < 0.05, "a thumb before any scroll")
    scroll.contentView.scroll(to: NSPoint(x: 0, y: 450))
    scroll.reflectScrolledClipView(scroll.contentView)
    settle(host)
    #expect(try brightness(host, x: 197.5, y: 150) < 0.05, "a scroll the app made showed the thumb")
    track.userScrolled()
    scroll.contentView.scroll(to: NSPoint(x: 0, y: 452))
    scroll.reflectScrolledClipView(scroll.contentView)
    settle(host)
    // 1200 tall, 300 showing, 452 down: a thumb 75 long, from 113 down.
    #expect(try brightness(host, x: 197.5, y: 150) > 0.15, "no thumb after the owner's scroll")
    #expect(try brightness(host, x: 197.5, y: 40) < 0.05, "the thumb is not where the scroll puts it")
    #expect(try brightness(host, x: 190, y: 150) < 0.05, "the thumb is wider than its 4")
  }

  /// The chips fill the width they are offered, as the kit's flex-wrap block does, not only their widest row.
  @Test func theChoicesTakeTheWidthTheyAreOffered() throws {
    let chips = VStack(alignment: .leading) {
      KOSChoices([(1, "One"), (2, "Two")], selected: 1) { _ in }.background(Color.red)
    }
    .frame(width: 300, height: 60, alignment: .topLeading)
    .background(Color.black)
    let host = window(chips, width: 300, height: 60)
    #expect(try colour(host, x: 295, y: 10).redComponent > 0.9)
  }
}

private final class FlippedPage: NSView {
  override var isFlipped: Bool { true }
}
