import AppKit
import DeviceCore
import DeviceUI

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
  /// A chat on the paired KOS's dashboard, by its id.
  var chatLink: (String) -> URL? = { _ in nil }

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
  /// While KOS works in one window: keeps the session's coordinates and the border on it.
  private var follower: Timer?

  /// How long after the owner hands control over that the pointer is not watched.
  private static let handOverGrace: TimeInterval = 3

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
    overlay.onExtend = { [weak self] in self?.extend() }
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
    Log.session.notice("asked by \(params.requester, privacy: .public) for \(params.minutes, privacy: .public) min: \(task, privacy: .private)")
    try sessions.ask(params.session)
    if let missing = SystemPermissions.missing(SystemPermissions.current()) {
      sessions.deny(params.session)
      throw DeviceError(.permission, missing)
    }

    let minutes: Int
    let picked: String
    let longest = settings.longestMinutes
    // What KOS may work in: the screen, or one of the windows open now. KOS's suggestion, if it made one, comes first.
    let windows = await WindowCatalog.windows(hiding: settings)
    let hint = params.target?.app?.trimmingCharacters(in: .whitespaces).lowercased()
    let suggested = hint.flatMap { h in windows.first { $0.app.lowercased().contains(h) || $0.bundle.lowercased() == h } }
    if settings.askFirst {
      let choices = [TargetChoice(id: TargetChoice.screen, title: "Entire screen", app: nil, icon: nil)]
        + windows.map { TargetChoice(id: String($0.id), title: $0.title, app: $0.app, icon: NSRunningApplication(processIdentifier: $0.pid)?.icon) }
      let request = ConsentPrompt.Request(
        task: task, requester: params.requester, chat: params.conversation.flatMap(chatLink),
        offered: Durations.offered(requested: params.minutes, longest: longest), longest: longest, wait: settings.promptWaitSeconds,
        targets: choices, target: suggested.map { String($0.id) } ?? TargetChoice.screen, suggested: suggested?.app)
      switch await consent.ask(request) {
      case .allowed(let chosen, let target):
        minutes = chosen
        picked = target
      case .denied:
        Log.session.notice("declined by the owner")
        sessions.deny(params.session)
        throw DeviceError(.denied, "The owner declined on this Mac.")
      case .unanswered:
        Log.session.notice("nobody answered")
        sessions.deny(params.session)
        throw DeviceError(.denied, "Nobody answered on this Mac in time.")
      case .withdrawn:
        Log.session.notice("withdrawn before an answer")
        sessions.deny(params.session)
        throw DeviceError(.noSession, "The request was withdrawn.")
      }
    } else {
      // The owner chose, on this Mac, to let KOS's approval queue decide: the window KOS named, if open, else the screen.
      minutes = Durations.unattended(requested: params.minutes, longest: longest)
      picked = suggested.map { String($0.id) } ?? TargetChoice.screen
    }

    let target: SessionTarget
    let frame: CGRect
    let id: CGDirectDisplayID
    if let window = windows.first(where: { String($0.id) == picked }) {
      frame = WindowCatalog.frame(of: window.id) ?? window.frame
      target = .window(id: window.id, pid: window.pid, app: window.app, title: window.title)
      id = Self.display(at: CGPoint(x: frame.midX, y: frame.midY))
    } else {
      id = Displays.underCursor()
      frame = CGDisplayBounds(id)
      target = .screen(display: id)
    }
    let space = Space(display: Rect(frame), maxEdge: edge)
    sessions.idleLimit = TimeInterval(settings.idleMinutes * 60)
    let session = try sessions.grant(
      params.session, task: task, requester: params.requester, conversation: params.conversation, minutes: minutes,
      target: target, space: space, now: Date())
    display = id
    maxEdge = edge
    Log.session.notice("live for \(minutes, privacy: .public) min in \(picked == TargetChoice.screen ? "the screen" : "one window", privacy: .public)")
    if case .window = target {
      overlay.show(display: id, task: task, until: session.until, window: frame)
      // Up front, as a shared window is, so KOS's first look is at it.
      if let window = windows.first(where: { String($0.id) == picked }) { await WindowCatalog.raise(window) }
    } else {
      overlay.show(display: id, task: task, until: session.until)
    }
    owner.start(grace: Self.handOverGrace)
    ticker = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.tick() }
    }
    if case .window = target {
      follower = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
        MainActor.assumeIsolated { self?.followWindow() }
      }
    }
    onChange?()
    return SessionBeginResult(until: Int64(session.until.timeIntervalSince1970 * 1000), space: space.size, target: target.info)
  }

  private static func display(at point: CGPoint) -> CGDirectDisplayID {
    var id = CGMainDisplayID()
    var count: UInt32 = 0
    _ = CGGetDisplaysWithPoint(point, 1, &id, &count)
    return count > 0 ? id : CGMainDisplayID()
  }

  /// The window KOS works in moved, was resized, went to another display, or closed: the session follows, or ends.
  private func followWindow() {
    guard let session = sessions.live, case .window(let id, _, _, _) = session.target else { return }
    guard let frame = WindowCatalog.frame(of: id) else { return end(.window) }
    sessions.follow(Rect(frame))
    if !overlay.follow(window: frame) {
      let next = Self.display(at: CGPoint(x: frame.midX, y: frame.midY))
      display = next
      overlay.show(display: next, task: session.task, until: session.until, window: frame)
      overlay.setPaused(session.paused)
    }
  }

  /// Before KOS acts in its window: the window as it is now, in front, or the session is over.
  private func bringForward(_ session: LiveSession) async throws -> LiveSession {
    guard case .window(let id, let pid, let app, let title) = session.target else { return session }
    guard let frame = WindowCatalog.frame(of: id) else {
      end(.window)
      throw DeviceError(.noSession, "The window KOS was given has closed.")
    }
    sessions.follow(Rect(frame))
    if !WindowCatalog.isFront(id) || NSWorkspace.shared.frontmostApplication?.processIdentifier != pid {
      await WindowCatalog.raise(WindowCatalog.Entry(id: id, pid: pid, app: app, bundle: "", title: title, frame: frame))
    }
    return sessions.live ?? session
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
    Log.session.notice("ended: \(reason?.rawValue ?? "by KOS or the line", privacy: .public)")
    owner.stop()
    ticker?.invalidate()
    ticker = nil
    follower?.invalidate()
    follower = nil
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
    Log.session.notice("paused: the owner took over")
    overlay.setPaused(true)
    emit(.sessionPaused, SessionPausedEvent(session: id))
    onChange?()
  }

  func resume() {
    guard let id = sessions.resume(now: Date()) else { return }
    Log.session.notice("resumed")
    overlay.setPaused(false)
    owner.ignorePointer(for: Self.handOverGrace)
    emit(.sessionResumed, SessionResumedEvent(session: id))
    onChange?()
  }

  func stop() {
    end(.owner)
  }

  /// The owner gave KOS fifteen more minutes; KOS hears the new end.
  func extend() {
    guard let id = sessions.live?.id, let until = sessions.extend(now: Date()) else { return }
    overlay.setUntil(until)
    emit(.sessionExtended, SessionExtendedEvent(session: id, until: until))
    onChange?()
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
      let session = try await bringForward(try authorize(p.session, needs: .input))
      let target = try globalPoint(p.x, p.y, in: session)
      try refuseHidden(at: target)
      await overlay.clear([target])
      try await injector.move(to: target)
      return cursor(in: session)

    case .pointerClick:
      let p = try call.params(ClickParams.self)
      let session = try await bringForward(try authorize(p.session, needs: .input))
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
      let session = try await bringForward(try authorize(p.session, needs: .input))
      let from = try globalPoint(p.from.x, p.from.y, in: session)
      let to = try globalPoint(p.to.x, p.to.y, in: session)
      try refuseHidden(at: from)
      try refuseHidden(at: to)
      await overlay.clear([from, to])
      try await injector.drag(from: from, to: to)
      return cursor(in: session)

    case .pointerScroll:
      let p = try call.params(ScrollParams.self)
      let session = try await bringForward(try authorize(p.session, needs: .input))
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
      let session = try await bringForward(try authorize(p.session, needs: .input))
      guard p.text.count <= Limits.typedCharacters else {
        throw DeviceError.badRequest("text is at most \(Limits.typedCharacters) characters; send it in parts.")
      }
      try refuseKeys()
      try await injector.type(Typing.steps(for: p.text))
      return cursor(in: session)

    case .keysPress:
      let p = try call.params(PressParams.self)
      let session = try await bringForward(try authorize(p.session, needs: .input))
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

  private func capture(_ authorized: LiveSession, region: Rect?) async throws -> CaptureResult {
    guard let display else { throw DeviceError(.noSession, "The session has no display.") }
    // A window is pictured where it is now, whatever covers it; it need not be in front to be seen.
    var session = authorized
    if case .window(let id, _, _, _) = session.target {
      guard let frame = WindowCatalog.frame(of: id) else {
        end(.window)
        throw DeviceError(.noSession, "The window KOS was given has closed.")
      }
      sessions.follow(Rect(frame))
      session = sessions.live ?? session
    }
    var source: CGRect?
    var pixels = session.space.size
    if let region {
      let part = try session.space.regionToGlobal(region)
      source = part.cg
      let scale = Displays.screen(for: display)?.backingScaleFactor ?? 2
      pixels = Space.captureSize(of: part, backingScale: scale, maxEdge: maxEdge)
    }
    let shot: ScreenCapturer.Shot
    if case .window(let id, _, _, _) = session.target {
      shot = try await capturer.capture(window: id, frame: session.space.display.cg, region: source, pixels: pixels)
    } else {
      shot = try await capturer.capture(display: display, region: source, pixels: pixels, hiding: settings.hiddenApps)
    }
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
