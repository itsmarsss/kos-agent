import AppKit
import SwiftUI

/// A vertical scroll view with the kit's overlay thumb (OverlayScroll.ts): no
/// lane of its own, a thin thumb over the content's right edge that shows
/// while the owner scrolls or the pointer is near that edge, and fades 800 ms
/// after.
///
/// macOS draws its legacy scroller, a wide grey lane that is always there,
/// when a mouse is attached or "Show scroll bars" is Always; `.never` is the
/// one indicator setting that preference cannot override, so the system's
/// bar is never drawn and this thumb is the only one. Scrolling stays the
/// scroll view's own: trackpad, wheel, keys and accessibility are untouched,
/// and the thumb is hidden from assistive tech. It takes a press only with the
/// pointer on it as drawn, so what lies at the content's edge stays
/// pressable, and a drag on it scrolls the page. A scroll the app makes (the
/// chat following a turn as it streams) moves it without showing it.
public struct OverlayScroll<Content: View>: View {
  private let content: Content
  @StateObject private var track = ScrollTrack()
  @State private var space = UUID()

  public init(@ViewBuilder content: () -> Content) {
    self.content = content()
  }

  /// Over a track given, so a test can see and drive it.
  init(track: ScrollTrack, @ViewBuilder content: () -> Content) {
    self.content = content()
    _track = StateObject(wrappedValue: track)
  }

  public var body: some View {
    ScrollView(.vertical) {
      content
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(space)) } action: { frame in
          track.measure(offset: -frame.minY, content: frame.height)
        }
        .background(ScrollFinder(track: track))
    }
    .scrollIndicators(.never)
    .coordinateSpace(.named(space))
    .onGeometryChange(for: CGSize.self) { $0.size } action: { track.measure(size: $0) }
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

/// The time the thumb keeps: what time it is, and running something after a while. The app's is the
/// continuous clock; a test's moves only when the test says.
@MainActor
protocol ScrollClock {
  var now: ContinuousClock.Instant { get }
  func after(_ delay: Duration, _ run: @escaping @MainActor () -> Void)
}

/// The continuous clock, waking on the main actor.
struct SystemScrollClock: ScrollClock {
  nonisolated init() {}

  var now: ContinuousClock.Instant { .now }

  func after(_ delay: Duration, _ run: @escaping @MainActor () -> Void) {
    Task { @MainActor in
      try? await Task.sleep(for: delay)
      run()
    }
  }
}

/// The thumb's state: what it is drawn from (how far down the page is, how
/// tall it is, how much shows), where the pointer is, whether it shows, and
/// the scroll view a drag moves.
@MainActor
final class ScrollTrack: ObservableObject {
  /// How long the thumb stays after the last scroll or hover.
  var fade: Duration = .milliseconds(800)
  private let clock: any ScrollClock
  /// How long after a wheel or trackpad event a move of the page is the owner's.
  static let userWindow: Duration = .milliseconds(250)

  @Published private(set) var offset: CGFloat = 0
  @Published private(set) var content: CGFloat = 0
  @Published private(set) var visible: CGFloat = 0
  private var width: CGFloat = 0
  /// The pointer near the right edge, which shows the thumb, and on the thumb as drawn, which lets it take a press.
  @Published private(set) var near = false
  @Published private(set) var grab = false
  @Published private(set) var shown = false
  @Published private(set) var dragging = false
  /// Where the pointer last was over the view, so a page moving under a still pointer is seen.
  private var pointer: CGPoint?
  private var userUntil: ContinuousClock.Instant?
  private var dragStart: (offset: CGFloat, ratio: CGFloat)?
  private var hideAt: ContinuousClock.Instant?
  /// Whether a fade is waiting: one at a time, however often it is put back.
  private var fading = false
  weak var scrollView: NSScrollView?

  init(clock: any ScrollClock = SystemScrollClock()) {
    self.clock = clock
  }

  var bar: ThumbBar? { ThumbBar(offset: offset, content: content, visible: visible) }
  /// Lit with the pointer on it or while it is dragged: darker, and 1.6 times as wide toward the content.
  var lit: Bool { grab || dragging }
  var widen: CGFloat { lit ? 1.6 : 1 }
  /// A press reaches the thumb only while it shows and the pointer is on it as drawn.
  var pressable: Bool { shown && lit }

  func measure(offset: CGFloat, content: CGFloat) {
    let moved = offset != self.offset
    if moved { self.offset = offset }
    if content != self.content { self.content = content }
    regrab()
    if moved, let userUntil, clock.now <= userUntil { show() }
  }

  func measure(size: CGSize) {
    if size.height != visible { visible = size.height }
    width = size.width
    regrab()
  }

  /// A wheel or trackpad event over the view (momentum too): the page moving now is the owner scrolling it.
  func userScrolled() {
    userUntil = clock.now + Self.userWindow
  }

  /// Where the pointer is over the scroll view, nil once it has left.
  func hover(_ at: CGPoint?) {
    pointer = at
    let isNear = at.map { $0.x >= width - ThumbBar.edge && $0.x <= width } ?? false
    if isNear != near {
      near = isNear
      if near { show() } else { keepShown() }
    }
    regrab()
  }

  /// Whether the pointer is on the thumb as drawn, again whenever the thumb or the pointer moves.
  private func regrab() {
    let onBar = pointer.flatMap { at in
      bar.map { at.x >= width - ThumbBar.inset - ThumbBar.width && at.x <= width && at.y >= $0.top && at.y <= $0.top + $0.size }
    } ?? false
    if onBar != grab {
      grab = onBar
      if !grab { keepShown() }
    }
  }

  func beginDrag() {
    guard let bar else { return }
    dragStart = (offset, bar.ratio)
    dragging = true
    show()
  }

  /// The pointer `dy` from where the drag began: the page that far times what a point of the thumb stands for.
  func drag(_ dy: CGFloat) {
    guard let dragStart else { return }
    scroll(to: dragStart.offset + dy * dragStart.ratio)
  }

  func endDrag() {
    dragStart = nil
    dragging = false
    keepShown()
  }

  /// Scroll so the page's top is `offset` down, kept within the page and the view's content insets.
  func scroll(to offset: CGFloat) {
    guard let scrollView, let document = scrollView.documentView else { return }
    let clip = scrollView.contentView
    let insets = scrollView.contentInsets
    let top = -insets.top
    let bottom = max(top, document.frame.height - clip.bounds.height + insets.bottom)
    let y = min(bottom, max(top, offset))
    clip.scroll(to: NSPoint(x: clip.bounds.minX, y: document.isFlipped ? y : bottom + top - y))
    scrollView.reflectScrolledClipView(clip)
  }

  private func show() {
    guard bar != nil else { return }
    if !shown { shown = true }
    keepShown()
  }

  /// One trailing fade: each call moves the time it fades at, and a single wait runs to the last of them.
  private func keepShown() {
    guard shown else { return }
    hideAt = clock.now + fade
    guard !fading else { return }
    fading = true
    wait(fade)
  }

  private func wait(_ delay: Duration) {
    clock.after(delay) { [weak self] in
      guard let self, let at = self.hideAt else { return }
      let left = at - self.clock.now
      if left > .zero { return self.wait(left) }
      self.fading = false
      self.hideAt = nil
      if !self.near && !self.lit { self.shown = false }
    }
  }
}

/// Where the thumb sits, and how long it is, in the scroll view's own points.
struct ThumbBar: Equatable {
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

/// The thumb as drawn: the text's colour at 30%, 48% lit.
private struct OverlayThumb: View {
  @ObservedObject var track: ScrollTrack
  @Environment(\.accessibilityReduceMotion) private var still

  var body: some View {
    if let bar = track.bar {
      Capsule()
        .fill(Theme.text.opacity(track.lit ? 0.48 : 0.30))
        .frame(width: ThumbBar.width, height: bar.size)
        .scaleEffect(x: track.widen, y: 1, anchor: .trailing)
        .padding(.trailing, ThumbBar.inset)
        .contentShape(Rectangle())
        .gesture(DragGesture(minimumDistance: 0, coordinateSpace: .global)
          .onChanged { change in
            if !track.dragging { track.beginDrag() }
            track.drag(change.translation.height)
          }
          .onEnded { _ in track.endDrag() })
        .allowsHitTesting(track.pressable)
        .offset(y: bar.top)
        .opacity(track.shown ? 1 : 0)
        .animation(still ? nil : .easeOut(duration: track.shown ? 0.12 : 0.28), value: track.shown)
        .animation(still ? nil : Theme.hover, value: track.lit)
        .accessibilityHidden(true)
    }
  }
}

/// Finds the scroll view the page is drawn in, so a drag on the thumb can move
/// it, and hears the wheel and trackpad over it, so only the owner's scrolling shows the thumb.
private struct ScrollFinder: NSViewRepresentable {
  let track: ScrollTrack

  func makeNSView(context: Context) -> Finder {
    Finder(track: track)
  }

  func updateNSView(_ view: Finder, context: Context) {}

  final class Finder: NSView {
    private let track: ScrollTrack
    private var monitor: Any?

    init(track: ScrollTrack) {
      self.track = track
      super.init(frame: .zero)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override func viewDidMoveToWindow() {
      super.viewDidMoveToWindow()
      if let monitor { NSEvent.removeMonitor(monitor) }
      monitor = nil
      let scroll = enclosingScrollView
      MainActor.assumeIsolated { track.scrollView = scroll }
      guard window != nil, scroll != nil else { return }
      monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
        MainActor.assumeIsolated {
          if let self, let scroll = self.enclosingScrollView, event.window === scroll.window,
            scroll.bounds.contains(scroll.convert(event.locationInWindow, from: nil))
          {
            self.track.userScrolled()
          }
        }
        return event
      }
    }

    // Presses go to the page, never to this.
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    deinit {
      if let monitor { NSEvent.removeMonitor(monitor) }
    }
  }
}
