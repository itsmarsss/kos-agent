import AppKit
import SwiftUI

/// A vertical scroll view with the kit's overlay thumb (OverlayScroll.ts): no
/// lane of its own, a thin thumb over the content's right edge that shows
/// while it scrolls or the pointer is near that edge, and fades 800 ms after.
///
/// macOS draws its legacy scroller, a wide grey lane that is always there,
/// when a mouse is attached or "Show scroll bars" is Always; `.never` is the
/// one indicator setting that preference cannot override, so the system's
/// bar is never drawn and this thumb is the only one. Scrolling stays the
/// scroll view's own: trackpad, wheel, keys and accessibility are untouched,
/// and the thumb is hidden from assistive tech. It takes a press only with the
/// pointer on it, so what lies at the content's edge stays pressable, and a
/// drag on it scrolls the page.
public struct OverlayScroll<Content: View>: View {
  private let content: Content
  /// Not observed here: the thumb alone redraws as the page scrolls.
  @State private var track = ScrollTrack()
  @State private var space = UUID()

  public init(@ViewBuilder content: () -> Content) {
    self.content = content()
  }

  public var body: some View {
    ScrollView(.vertical) {
      content
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(space)) } action: { frame in
          track.offset = -frame.minY
          track.content = frame.height
        }
        .background(ScrollFinder(track: track))
    }
    .scrollIndicators(.never)
    .coordinateSpace(.named(space))
    .onGeometryChange(for: CGSize.self) { $0.size } action: { size in
      track.visible = size.height
      track.width = size.width
    }
    .overlay(alignment: .topTrailing) { OverlayThumb(track: track) }
    // Over the scroll view and its thumb, not a strip at its edge, so the content under the edge keeps its own pointer and presses.
    .onContinuousHover { phase in
      switch phase {
      case .active(let at): track.hover(at)
      case .ended: track.hover(nil)
      }
    }
  }
}

/// What the thumb is drawn from: how far down the page is, how tall it is,
/// and how much of it shows; and the scroll view, for a drag to move.
@MainActor
final class ScrollTrack: ObservableObject {
  @Published var offset: CGFloat = 0
  @Published var content: CGFloat = 0
  @Published var visible: CGFloat = 0
  /// The pointer near the right edge, which shows the thumb, and on the thumb as drawn, which lets it take a press.
  @Published private(set) var near = false
  @Published private(set) var grab = false
  var width: CGFloat = 0
  weak var scrollView: NSScrollView?

  var bar: ThumbBar? { ThumbBar(offset: offset, content: content, visible: visible) }

  /// Where the pointer is over the scroll view, nil once it has left.
  func hover(_ at: CGPoint?) {
    guard let at else {
      if near { near = false }
      if grab { grab = false }
      return
    }
    let isNear = at.x >= width - ThumbBar.edge && at.x <= width
    if isNear != near { near = isNear }
    let onBar = bar.map { at.x >= width - ThumbBar.inset - ThumbBar.width && at.y >= $0.top && at.y <= $0.top + $0.size } ?? false
    if onBar != grab { grab = onBar }
  }

  /// Scroll so the page's top is `offset` down, within the page.
  func scroll(to offset: CGFloat) {
    guard let scrollView, let document = scrollView.documentView else { return }
    let clip = scrollView.contentView
    let span = max(0, document.frame.height - clip.bounds.height)
    let y = min(span, max(0, offset))
    clip.scroll(to: NSPoint(x: clip.bounds.minX, y: document.isFlipped ? y : span - y))
    scrollView.reflectScrolledClipView(clip)
  }
}

/// Where the thumb sits, and how long it is, in the scroll view's own points.
struct ThumbBar: Equatable {
  /// How long the thumb stays after the last scroll or hover.
  static let fade: Duration = .milliseconds(800)
  /// The shortest thumb, so a very long page still has one to grab.
  static let minimum: CGFloat = 28
  /// Space between the thumb and the view's top, bottom and right edges.
  static let inset: CGFloat = 1
  /// The thumb's width at rest; it widens toward the content under the pointer.
  static let width: CGFloat = 4
  /// How near the right edge the pointer shows the thumb.
  static let edge: CGFloat = 8

  let top: CGFloat
  let size: CGFloat
  /// How far the page moves for a point the thumb moves.
  let ratio: CGFloat

  /// The thumb for a page `content` tall, `visible` of it showing, `offset` down; none when it all fits.
  init?(offset: CGFloat, content: CGFloat, visible: CGFloat) {
    let span = content - visible
    let track = visible - 2 * Self.inset
    guard span >= 1, track > Self.minimum else { return nil }
    size = max(Self.minimum, (track * visible / content).rounded())
    top = Self.inset + (track - size) * min(span, max(0, offset)) / span
    ratio = span / max(1, track - size)
  }
}

/// The thumb itself: the text's colour at 30%, 48% and wider with the pointer on it.
private struct OverlayThumb: View {
  @ObservedObject var track: ScrollTrack
  @Environment(\.accessibilityReduceMotion) private var still
  @State private var shown = false
  @State private var drag: CGFloat?
  @State private var fade: Task<Void, Never>?

  var body: some View {
    if let bar = track.bar {
      let lit = track.grab || drag != nil
      Capsule()
        .fill(Theme.text.opacity(lit ? 0.48 : 0.30))
        .frame(width: ThumbBar.width, height: bar.size)
        .scaleEffect(x: lit ? 1.6 : 1, y: 1, anchor: .trailing)
        .padding(.trailing, ThumbBar.inset)
        .contentShape(Rectangle())
        .gesture(DragGesture(minimumDistance: 0, coordinateSpace: .global)
          .onChanged { change in
            let start = drag ?? track.offset
            if drag == nil { drag = start }
            track.scroll(to: start + change.translation.height * bar.ratio)
          }
          .onEnded { _ in
            drag = nil
            hideLater()
          })
        // Shown only to the pointer: a press reaches the thumb only with the pointer on it.
        .allowsHitTesting(shown && lit)
        .offset(y: bar.top)
        .opacity(shown ? 1 : 0)
        .animation(still ? nil : .easeOut(duration: shown ? 0.12 : 0.28), value: shown)
        .animation(still ? nil : Theme.hover, value: lit)
        .accessibilityHidden(true)
        .onChange(of: track.offset) { show() }
        .onChange(of: track.near) { if track.near { show() } else { hideLater() } }
        .onChange(of: track.grab) { if !track.grab { hideLater() } }
    }
  }

  private func show() {
    shown = true
    hideLater()
  }

  private func hideLater() {
    fade?.cancel()
    fade = Task { @MainActor in
      try? await Task.sleep(for: ThumbBar.fade)
      guard !Task.isCancelled, !track.near, !track.grab, drag == nil else { return }
      shown = false
    }
  }
}

/// Finds the scroll view the page is drawn in, so a drag on the thumb can move it.
private struct ScrollFinder: NSViewRepresentable {
  let track: ScrollTrack

  func makeNSView(context: Context) -> Finder {
    Finder(track: track)
  }

  func updateNSView(_ view: Finder, context: Context) {}

  final class Finder: NSView {
    private let track: ScrollTrack

    init(track: ScrollTrack) {
      self.track = track
      super.init(frame: .zero)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override func viewDidMoveToWindow() {
      super.viewDidMoveToWindow()
      MainActor.assumeIsolated { track.scrollView = enclosingScrollView }
    }

    // Presses go to the page, never to this.
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
  }
}
