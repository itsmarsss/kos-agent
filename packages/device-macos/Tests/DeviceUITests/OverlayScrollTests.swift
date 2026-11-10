import AppKit
import SwiftUI
import Testing

@testable import DeviceUI

/// The overlay thumb (OverlayScroll.swift): where it sits, that it takes no lane, and that it shows on a scroll.
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

  /// The page is drawn in a window, as the app draws it, and scrolled as a wheel would.
  private func host(_ height: CGFloat) -> (NSHostingView<some View>, NSScrollView) {
    let view = OverlayScroll { Color.black.frame(height: height) }.frame(width: 200, height: 300).background(Color.black)
    let host = NSHostingView(rootView: view)
    host.frame = CGRect(x: 0, y: 0, width: 200, height: 300)
    let window = NSWindow(contentRect: host.frame, styleMask: .borderless, backing: .buffered, defer: false)
    window.appearance = NSAppearance(named: .darkAqua)
    window.contentView = host
    host.layoutSubtreeIfNeeded()
    return (host, scrollView(in: host)!)
  }

  private func scrollView(in view: NSView) -> NSScrollView? {
    if let scroll = view as? NSScrollView { return scroll }
    return view.subviews.lazy.compactMap { scrollView(in: $0) }.first
  }

  /// How bright the window is at a point (in points from its top left).
  private func brightness(_ host: NSView, x: CGFloat, y: CGFloat) throws -> CGFloat {
    let rep = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
    host.cacheDisplay(in: host.bounds, to: rep)
    let scale = CGFloat(rep.pixelsWide) / host.bounds.width
    let colour = try #require(rep.colorAt(x: Int(x * scale), y: Int(y * scale))?.usingColorSpace(.sRGB))
    return colour.brightnessComponent
  }

  private func settle(_ host: NSView) {
    for _ in 0..<5 {
      RunLoop.main.run(until: Date().addingTimeInterval(0.03))
      host.layoutSubtreeIfNeeded()
    }
  }

  @Test func thePageTakesTheWholeWidthWhateverTheSystemScrollerIs() {
    let (_, scroll) = host(2000)
    // The legacy scroller's lane would leave the page 15 short of the view.
    #expect(scroll.contentView.bounds.width == 200)
    #expect(scroll.verticalScroller.map { $0.isHidden || !scroll.hasVerticalScroller || $0.frame.width == 0 } ?? true)
  }

  @Test func theThumbShowsOnAScrollAndOverTheEdge() throws {
    let (host, scroll) = host(1200)
    settle(host)
    #expect(try brightness(host, x: 197.5, y: 20) < 0.05, "a thumb before any scroll")
    scroll.contentView.scroll(to: NSPoint(x: 0, y: 450))
    scroll.reflectScrolledClipView(scroll.contentView)
    settle(host)
    // 1200 tall, 300 showing, 450 down: a thumb 75 long, from 113 down.
    #expect(try brightness(host, x: 197.5, y: 150) > 0.15, "no thumb after a scroll")
    #expect(try brightness(host, x: 197.5, y: 40) < 0.05, "the thumb is not where the scroll puts it")
    #expect(try brightness(host, x: 190, y: 150) < 0.05, "the thumb is wider than its 4")
  }
}
