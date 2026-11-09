import AppKit
import DeviceUI
import SwiftUI

/// The chat window: floating over the owner's apps, dragged anywhere by its
/// background, and never taking the front from the app the owner is in, so
/// "this" stays that app. A panel that can be typed in without activating
/// KOS for Mac; where it was left is where it opens next.
@MainActor
final class ChatWindow: NSPanel {
  private static let place = "KOSChatWindow"
  /// The window took the keyboard: what the owner selected is read again.
  var onKey: (() -> Void)?

  init(model: ChatModel) {
    super.init(
      contentRect: NSRect(origin: .zero, size: ChatView.size),
      styleMask: [.nonactivatingPanel, .titled, .closable, .resizable, .fullSizeContentView],
      backing: .buffered, defer: false)
    titleVisibility = .hidden
    titlebarAppearsTransparent = true
    for button in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] { standardWindowButton(button)?.isHidden = true }
    isMovableByWindowBackground = true
    isFloatingPanel = true
    level = .floating
    collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    hidesOnDeactivate = false
    becomesKeyOnlyIfNeeded = false
    isReleasedWhenClosed = false
    backgroundColor = NSColor(Theme.bg)
    contentView = NSHostingView(rootView: ChatView(model: model))
    minSize = ChatView.smallest
    setFrameAutosaveName(Self.place)
    if !setFrameUsingName(Self.place), let screen = NSScreen.main {
      // The first time: the top right of the screen, out of the way of what the owner is doing.
      let area = screen.visibleFrame
      setFrameOrigin(NSPoint(x: area.maxX - frame.width - 24, y: area.maxY - frame.height - 24))
    }
  }

  override var canBecomeKey: Bool { true }

  override func becomeKey() {
    super.becomeKey()
    onKey?()
  }

  func present() {
    orderFrontRegardless()
    makeKey()
  }
}
