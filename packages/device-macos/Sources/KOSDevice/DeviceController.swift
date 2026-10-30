import AppKit
import DeviceCore

/// What a call from KOS does on this Mac, and the session around it.
///
/// Every call is checked against the session first (`Sessions` holds the
/// rules), then against the Mac: permissions, a password field with focus,
/// an app on the hidden list. Actions run one at a time in the order they
/// came; asking the owner and ending a session do not wait behind them.
@MainActor
final class DeviceController {
  /// An event for KOS.
  var send: ((Data) -> Void)?
  /// The session started, paused, resumed or ended: the menu redraws.
  var onChange: (() -> Void)?

  private var sessions = Sessions()
  private var display: CGDirectDisplayID?
  private var maxEdge = Limits.defaultMaxEdge
  private let settings: Settings
  private let overlay: OverlayController
  private let injector = InputInjector()
  private let capturer = ScreenCapturer()
  private let owner = OwnerInputMonitor()
  private let consent = ConsentPrompt()
  private var queue: Task<Void, Never>?
  private var ticker: Timer?

  /// How long after the owner hands control over that the pointer is not watched.
  private static let handOverGrace: TimeInterval = 1.5

  init(settings: Settings, overlay: OverlayController) {
    self.settings = settings
    self.overlay = overlay
    injector.onPointer = { [weak overlay] point in overlay?.pointer(at: point) }
    injector.onKeys = { [weak overlay] in overlay?.typing() }
    owner.onOwnerInput = { [weak self] in self?.pause() }
    owner.isFromKOS = { [weak injector] event in injector?.posted(event) ?? false }
    overlay.onPause = { [weak self] in self?.pause() }
    overlay.onResume = { [weak self] in self?.resume() }
    overlay.onStop = { [weak self] in self?.stop() }
  }

  var live: LiveSession? { sessions.live }

  // MARK: Calls

  func handle(_ call: Call) async -> Data? {
    guard let method = CallMethod(rawValue: call.method) else {
      return try? Outbound.reply(id: call.id, error: .badRequest("\(call.method) is not a method this device knows."))
    }
    switch method {
    case .sessionBegin:
      return await answer(call) { try await self.begin(call.params(SessionBeginParams.self)) }
    case .sessionEnd:
      return await answer(call) { try self.endForKOS(call.params(SessionRef.self)) }
    default:
      return await inTurn { await self.answer(call) { try await self.act(method, call) } }
    }
  }

  private func answer(_ call: Call, _ work: () async throws -> any Encodable) async -> Data? {
    do {
      return try Outbound.reply(id: call.id, result: try await work())
    } catch let error as DeviceError {
      return try? Outbound.reply(id: call.id, error: error)
    } catch {
      return try? Outbound.reply(id: call.id, error: DeviceError(.internal, error.localizedDescription))
    }
  }

  /// Runs `work` after every action before it has finished.
  private func inTurn<T>(_ work: @escaping () async -> T) async -> T {
    let before = queue
    let mine = Task { @MainActor in
      await before?.value
      return await work()
    }
    queue = Task { _ = await mine.value }
    return await mine.value
  }

  // MARK: Session

  private func begin(_ params: SessionBeginParams) async throws -> SessionBeginResult {
    try Durations.validate(params.minutes)
    let edge = params.maxEdge ?? Limits.defaultMaxEdge
    guard Limits.maxEdgeRange.contains(edge) else {
      throw DeviceError.badRequest("maxEdge must be between \(Int(Limits.maxEdgeRange.lowerBound)) and \(Int(Limits.maxEdgeRange.upperBound)).")
    }
    let task = params.task.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !task.isEmpty else { throw DeviceError.badRequest("Say what the session is for in task.") }
    try sessions.ask(params.session)
    if let missing = SystemPermissions.missing(SystemPermissions.current()) {
      sessions.deny(params.session)
      throw DeviceError(.permission, missing)
    }

    let minutes: Int
    if settings.askFirst {
      let request = ConsentPrompt.Request(task: task, requester: params.requester, offered: Durations.offered(requested: params.minutes))
      switch await consent.ask(request) {
      case .allowed(let chosen):
        minutes = chosen
      case .denied:
        sessions.deny(params.session)
        throw DeviceError(.denied, "The owner declined on this Mac.")
      case .unanswered:
        sessions.deny(params.session)
        throw DeviceError(.denied, "Nobody answered on this Mac within a minute.")
      case .withdrawn:
        sessions.deny(params.session)
        throw DeviceError(.noSession, "The request was withdrawn.")
      }
    } else {
      // The owner chose, on this Mac, to let KOS's approval queue decide.
      minutes = Durations.unattended(requested: params.minutes)
    }

    let id = Displays.underCursor()
    let space = Space(display: Displays.bounds(id), maxEdge: edge)
    let session = try sessions.grant(params.session, task: task, requester: params.requester, minutes: minutes, space: space, now: Date())
    display = id
    maxEdge = edge
    overlay.show(display: id, task: task)
    owner.start(grace: Self.handOverGrace)
    ticker = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.tick() }
    }
    onChange?()
    return SessionBeginResult(until: Int64(session.until.timeIntervalSince1970 * 1000), space: space.size)
  }

  /// KOS ended it. Already over is fine: an end crossing an expiry is not an error.
  private func endForKOS(_ ref: SessionRef) throws -> EmptyResult {
    switch sessions.phase {
    case .asking(let id) where id == ref.session:
      consent.cancel()
    case .live(let session) where session.id == ref.session:
      end(nil)
    default:
      break
    }
    return EmptyResult()
  }

  /// Ends the session; tells KOS why unless KOS is who ended it or the line is gone.
  private func end(_ reason: EndReason?) {
    consent.cancel()
    guard let id = sessions.end() else { return }
    owner.stop()
    ticker?.invalidate()
    ticker = nil
    display = nil
    overlay.hide()
    if let reason { emit(.sessionEnded, SessionEndedEvent(session: id, reason: reason)) }
    onChange?()
  }

  private func tick() {
    if let reason = sessions.due(Date()) { end(reason) }
  }

  // MARK: The owner

  func pause() {
    guard let id = sessions.pause() else { return }
    overlay.setPaused(true)
    emit(.sessionPaused, SessionPausedEvent(session: id))
    onChange?()
  }

  func resume() {
    guard let id = sessions.resume(now: Date()) else { return }
    overlay.setPaused(false)
    owner.ignorePointer(for: Self.handOverGrace)
    emit(.sessionResumed, SessionResumedEvent(session: id))
    onChange?()
  }

  func stop() {
    end(.owner)
  }

  /// The line to KOS dropped: nothing outlives it.
  func lineDropped() {
    end(nil)
  }

  func quitting() {
    end(.quit)
  }

  private func emit<D: Encodable>(_ name: EventName, _ data: D) {
    if let message = try? Outbound.event(name, data: data) { send?(message) }
  }

  // MARK: Actions

  private func act(_ method: CallMethod, _ call: Call) async throws -> any Encodable {
    switch method {
    case .screenCapture:
      let p = try call.params(CaptureParams.self)
      let session = try authorize(p.session, needs: .screen)
      return try await capture(session, region: p.region)

    case .pointerMove:
      let p = try call.params(MoveParams.self)
      let session = try authorize(p.session, needs: .input)
      let target = try globalPoint(p.x, p.y, in: session)
      try refuseHidden(at: target)
      await overlay.clear([target])
      try await injector.move(to: target)
      return cursor(in: session)

    case .pointerClick:
      let p = try call.params(ClickParams.self)
      let session = try authorize(p.session, needs: .input)
      let count = p.count ?? 1
      guard (1...3).contains(count) else { throw DeviceError.badRequest("count must be 1, 2 or 3.") }
      let modifiers = try KeyCombo.modifiers(named: p.modifiers ?? [])
      let target = try globalPoint(p.x, p.y, in: session)
      try refuseHidden(at: target)
      await overlay.clear([target])
      try await injector.click(at: target, button: p.button ?? .left, count: count, modifiers: modifiers)
      overlay.ripple(at: target)
      return cursor(in: session)

    case .pointerDrag:
      let p = try call.params(DragParams.self)
      let session = try authorize(p.session, needs: .input)
      let from = try globalPoint(p.from.x, p.from.y, in: session)
      let to = try globalPoint(p.to.x, p.to.y, in: session)
      try refuseHidden(at: from)
      try refuseHidden(at: to)
      await overlay.clear([from, to])
      try await injector.drag(from: from, to: to)
      return cursor(in: session)

    case .pointerScroll:
      let p = try call.params(ScrollParams.self)
      let session = try authorize(p.session, needs: .input)
      guard p.dx.isFinite, p.dy.isFinite, abs(p.dx) <= Limits.scrollLines, abs(p.dy) <= Limits.scrollLines else {
        throw DeviceError.badRequest("dx and dy are lines, at most \(Int(Limits.scrollLines)) either way.")
      }
      let target = try globalPoint(p.x, p.y, in: session)
      try refuseHidden(at: target)
      await overlay.clear([target])
      try await injector.scroll(at: target, dx: Int(p.dx.rounded()), dy: Int(p.dy.rounded()))
      return cursor(in: session)

    case .keysType:
      let p = try call.params(TypeParams.self)
      let session = try authorize(p.session, needs: .input)
      guard p.text.count <= Limits.typedCharacters else {
        throw DeviceError.badRequest("text is at most \(Limits.typedCharacters) characters; send it in parts.")
      }
      try refuseKeys()
      try await injector.type(Typing.steps(for: p.text))
      return cursor(in: session)

    case .keysPress:
      let p = try call.params(PressParams.self)
      let session = try authorize(p.session, needs: .input)
      let combo = try KeyCombo.parse(p.keys)
      let times = p.repeat ?? 1
      guard (1...Limits.pressRepeats).contains(times) else {
        throw DeviceError.badRequest("repeat must be from 1 to \(Limits.pressRepeats).")
      }
      try refuseKeys()
      try await injector.press(combo, times: times)
      return cursor(in: session)

    case .sessionBegin, .sessionEnd:
      throw DeviceError(.internal, "\(method.rawValue) is not an action.")
    }
  }

  private func capture(_ session: LiveSession, region: Rect?) async throws -> CaptureResult {
    guard let display else { throw DeviceError(.noSession, "The session has no display.") }
    var source: CGRect?
    var pixels = session.space.size
    if let region {
      let part = try session.space.regionToGlobal(region)
      source = part.cg
      let scale = Displays.screen(for: display)?.backingScaleFactor ?? 2
      pixels = Space.captureSize(of: part, backingScale: scale, maxEdge: maxEdge)
    }
    let shot = try await capturer.capture(display: display, region: source, pixels: pixels, hiding: settings.hiddenApps)
    let front = Targets.frontmost()
    // A hidden app is not named either: KOS learns nothing of it.
    let app = settings.isHidden(front?.bundleIdentifier) ? nil : Targets.describe(front)
    return CaptureResult(
      image: shot.jpeg.base64EncodedString(), mediaType: "image/jpeg", width: shot.width, height: shot.height,
      cursor: session.space.fromGlobal(Point(Displays.cursor())), app: app)
  }

  // MARK: Checks

  /// The live session for this call, counted as activity, with what the action needs granted.
  private func authorize(_ id: String, needs permission: SystemPermissions.Kind) throws -> LiveSession {
    if let reason = sessions.due(Date()) {
      end(reason)
      throw DeviceError(.noSession, "The session is over.")
    }
    let session = try sessions.authorize(id, now: Date())
    guard SystemPermissions.isGranted(permission) else {
      throw DeviceError(.permission, "\(permission.title) is not granted on this Mac.")
    }
    // Checked again before every step, so the owner's hand or Stop halts an action half way.
    injector.interruption = { [weak self] in self?.interruption(for: id) }
    return session
  }

  private func interruption(for id: String) -> DeviceError? {
    guard let session = sessions.live, session.id == id else { return DeviceError(.noSession, "The session ended.") }
    return session.paused ? DeviceError(.paused, "The owner took over. Wait for them to resume it on this Mac.") : nil
  }

  private func globalPoint(_ x: Double, _ y: Double, in session: LiveSession) throws -> CGPoint {
    session.space.toGlobal(try session.space.validate(Point(x: x, y: y))).cg
  }

  private func cursor(in session: LiveSession) -> CursorResult {
    CursorResult(cursor: session.space.fromGlobal(Point(Displays.cursor())))
  }

  private func refuseHidden(at point: CGPoint) throws {
    let app = Targets.app(at: point)
    if settings.isHidden(app?.bundleIdentifier) {
      throw DeviceError(.hiddenApp, "\(app?.localizedName ?? "That app") is hidden from KOS on this Mac.")
    }
  }

  private func refuseKeys() throws {
    if Targets.passwordFieldHasFocus {
      throw DeviceError(.secureInput, "A password field has focus. KOS does not type there.")
    }
    let front = Targets.frontmost()
    if settings.isHidden(front?.bundleIdentifier) {
      throw DeviceError(.hiddenApp, "\(front?.localizedName ?? "The app in front") is hidden from KOS on this Mac.")
    }
  }
}
