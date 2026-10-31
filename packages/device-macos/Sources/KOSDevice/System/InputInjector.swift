import CoreGraphics
import DeviceCore
import Foundation

/// KOS's hands: mouse and keyboard events posted the way hardware posts them.
///
/// Every event carries `stamp`, so the owner-input monitor knows KOS's hand
/// from the owner's. Pointer moves glide rather than jump, so the owner can
/// follow them. Before every step the controller is asked whether to go on;
/// an action stopped half way lets go of any button or key it was holding,
/// so the owner never takes over with a stuck shift or a held drag.
@MainActor
final class InputInjector {
  static let stamp: Int64 = 0x4B4F_5344

  private let source = CGEventSource(stateID: .hidSystemState)
  /// Where and when the pointer was last sent, for telling KOS's motion apart even if the stamp is lost.
  private var lastPointer: (point: CGPoint, at: Date)?
  /// Each point the pointer passes, so KOS's cursor follows it.
  var onPointer: ((CGPoint) -> Void)?
  /// Each burst of typing, so the cursor's tag can say KOS is typing.
  var onKeys: (() -> Void)?
  /// Why to stop now, asked before each step; nothing to go on.
  var interruption: () -> DeviceError? = { nil }
  /// The owner would rather KOS's pointer got there than be watched getting there.
  var quick: () -> Bool = { false }

  func move(to target: CGPoint, holding button: MouseButton? = nil) async throws {
    let glide = Glide(from: Point(Displays.cursor()), to: Point(target), quick: quick())
    for point in glide.points {
      try check()
      let type = button.map(Self.dragType) ?? .mouseMoved
      post(CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point.cg, mouseButton: Self.cgButton(button ?? .left)))
      onPointer?(point.cg)
      try await wait(glide.interval)
    }
  }

  func click(at point: CGPoint, button: MouseButton, count: Int, modifiers: Modifiers) async throws {
    try await move(to: point)
    let flags = CGEventFlags(rawValue: modifiers.rawValue)
    for n in 1...count {
      try check()
      for down in [true, false] {
        let event = CGEvent(
          mouseEventSource: source, mouseType: down ? Self.downType(button) : Self.upType(button),
          mouseCursorPosition: point, mouseButton: Self.cgButton(button))
        event?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
        event?.flags = flags
        post(event)
      }
      // Quick enough to read as one double click, slow enough for apps to see two.
      if n < count { try await wait(0.06) }
    }
  }

  func drag(from start: CGPoint, to end: CGPoint) async throws {
    try await move(to: start)
    post(CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: start, mouseButton: .left))
    var released = false
    defer {
      if !released { releaseLeft() }
    }
    try await wait(0.05)
    try await move(to: end, holding: .left)
    try await wait(0.05)
    releaseLeft()
    released = true
  }

  /// Lines, positive down and right, one notch at a time so it scrolls rather than leaps.
  func scroll(at point: CGPoint, dx: Int, dy: Int) async throws {
    try await move(to: point)
    for step in 0..<max(abs(dx), abs(dy)) {
      try check()
      let vertical = step < abs(dy) ? Int32(-dy.signum()) : 0
      let horizontal = step < abs(dx) ? Int32(-dx.signum()) : 0
      post(CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: vertical, wheel2: horizontal, wheel3: 0))
      try await wait(0.012)
    }
  }

  func type(_ steps: [TypingStep]) async throws {
    for step in steps {
      try check()
      onKeys?()
      switch step {
      case .text(let run): postText(run)
      case .key(let combo): try await press(combo, times: 1)
      }
      try await wait(0.012)
    }
  }

  func press(_ combo: KeyCombo, times: Int) async throws {
    let held = Modifiers.pressable.filter { combo.modifiers.contains($0.0) }
    for n in 0..<times {
      try check()
      onKeys?()
      var flags: Modifiers = []
      var down: [(Modifiers, UInt16)] = []
      defer {
        for (modifier, code) in down.reversed() {
          flags.remove(modifier)
          postKey(code, down: false, flags: flags)
        }
      }
      for (modifier, code) in held {
        flags.insert(modifier)
        postKey(code, down: true, flags: flags)
        down.append((modifier, code))
      }
      postKey(combo.code, down: true, flags: flags.union(combo.implied))
      postKey(combo.code, down: false, flags: flags.union(combo.implied))
      if n < times - 1 { try await wait(0.03) }
    }
  }

  /// Whether an event seen system-wide is one this app posted: it carries the
  /// stamp, or it is the pointer arriving where KOS just sent it.
  func posted(_ event: CGEvent) -> Bool {
    if event.getIntegerValueField(.eventSourceUserData) == Self.stamp { return true }
    guard let last = lastPointer, Date().timeIntervalSince(last.at) < 0.25 else { return false }
    return hypot(event.location.x - last.point.x, event.location.y - last.point.y) < 1
  }

  // MARK: Posting

  private func post(_ event: CGEvent?) {
    guard let event else { return }
    event.setIntegerValueField(.eventSourceUserData, value: Self.stamp)
    if event.type != .keyDown, event.type != .keyUp, event.type != .scrollWheel {
      lastPointer = (event.location, Date())
    }
    event.post(tap: .cghidEventTap)
  }

  private func postKey(_ code: UInt16, down: Bool, flags: Modifiers) {
    let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
    event?.flags = CGEventFlags(rawValue: flags.rawValue)
    post(event)
  }

  /// A run of characters as one key event carrying them, whatever the keyboard layout.
  private func postText(_ run: String) {
    let units = Array(run.utf16)
    for down in [true, false] {
      let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
      event?.flags = []
      event?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
      post(event)
    }
  }

  private func releaseLeft() {
    post(CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: Displays.cursor(), mouseButton: .left))
  }

  private func check() throws {
    if let reason = interruption() { throw reason }
  }

  private func wait(_ seconds: Double) async throws {
    try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
  }

  // MARK: Buttons

  private static func cgButton(_ button: MouseButton) -> CGMouseButton {
    switch button {
    case .left: return .left
    case .right: return .right
    case .middle: return .center
    }
  }

  private static func downType(_ button: MouseButton) -> CGEventType {
    switch button {
    case .left: return .leftMouseDown
    case .right: return .rightMouseDown
    case .middle: return .otherMouseDown
    }
  }

  private static func upType(_ button: MouseButton) -> CGEventType {
    switch button {
    case .left: return .leftMouseUp
    case .right: return .rightMouseUp
    case .middle: return .otherMouseUp
    }
  }

  private static func dragType(_ button: MouseButton) -> CGEventType {
    switch button {
    case .left: return .leftMouseDragged
    case .right: return .rightMouseDragged
    case .middle: return .otherMouseDragged
    }
  }
}
