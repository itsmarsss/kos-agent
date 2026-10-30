import DeviceCore
import Foundation
import Network

/// The line to KOS: dialled out, proven both ways, kept up.
///
/// Nothing KOS sends is acted on until KOS has proven it holds the key
/// pinned at pairing. The line is pinged, redialled with backoff when it
/// drops, and redialled at once when the network comes back. A drop is
/// reported straight away, because a session must not outlive its line.
@MainActor
final class Connection: NSObject {
  enum Status: Equatable {
    case connecting
    case connected(name: String)
    case offline(String)
    /// The far end could not sign with KOS's key.
    case untrusted
    /// Another copy of this device took the line.
    case replaced
    /// KOS speaks another protocol version.
    case outdated
    /// The owner disconnected on purpose; nothing redials until they connect.
    case disconnected
  }

  private enum Close {
    static let malformed = 4001
    static let unknownDevice = 4003
    static let replaced = 4009
    static let unsupported = 4010
  }

  static let maxMessageBytes = 16 * 1024 * 1024
  private static let pingEvery: TimeInterval = 20
  private static let handshakeWithin: TimeInterval = 15

  var onStatus: ((Status) -> Void)?
  /// A call from a proven KOS; the answer to send, or nothing to send none.
  var onCall: ((Call) async -> Data?)?
  /// The line dropped: end anything live.
  var onDrop: (() -> Void)?
  /// KOS no longer knows this device.
  var onRemoved: (() -> Void)?
  /// What to tell KOS about this device in the hello.
  var state: () -> DeviceState = { DeviceState(consent: .device, permissions: Permissions(screen: false, input: false), displays: []) }

  private(set) var status: Status = .offline("Not started") {
    didSet { if status != oldValue { onStatus?(status) } }
  }

  private var pairing: Pairing?
  private var task: URLSessionWebSocketTask?
  private lazy var session = URLSession(configuration: .default, delegate: self, delegateQueue: .main)
  /// Bumped on every new dial, so a late event from an old line is ignored.
  private var generation = 0
  private var deviceNonce = ""
  private var proven = false
  private var backoff = Backoff()
  private var redial: Task<Void, Never>?
  private var pingTimer: Timer?
  private var handshakeTimer: Timer?
  private let path = NWPathMonitor()
  private var pathWasDown = false
  /// Set while the owner has disconnected on purpose: no redial, no reconnect on a network change.
  private var heldOff = false

  override init() {
    super.init()
    path.pathUpdateHandler = { [weak self] update in
      Task { @MainActor in self?.networkChanged(up: update.status == .satisfied) }
    }
    path.start(queue: .main)
  }

  var isProven: Bool { proven }

  func start(_ pairing: Pairing) {
    self.pairing = pairing
    heldOff = false
    backoff.reset()
    dial()
  }

  /// Keeps the pairing, but not the line: KOS sees this Mac offline until Connect.
  func hold(_ pairing: Pairing) {
    self.pairing = pairing
    heldOff = true
    hangUp(code: .normalClosure)
    status = .disconnected
  }

  /// Hangs up for good: unpairing or quitting.
  func stop() {
    pairing = nil
    hangUp(code: .normalClosure)
    status = .offline("Not paired")
  }

  func redialNow() {
    guard pairing != nil else { return }
    heldOff = false
    backoff.reset()
    dial()
  }

  /// Sends a message on a proven line; a message with no line to go on is dropped, as a session ends with it.
  func send(_ data: Data) {
    guard proven, let task else { return }
    let generation = generation
    task.send(.string(String(decoding: data, as: UTF8.self))) { [weak self] error in
      guard let error else { return }
      Task { @MainActor in
        guard let self, self.generation == generation else { return }
        self.lost(error.localizedDescription)
      }
    }
  }

  // MARK: Dialling

  private func dial() {
    hangUp(code: .goingAway)
    guard let pairing, let address = try? pairing.kosAddress() else {
      status = .offline("The saved address is not allowed. Pair again.")
      return
    }
    generation += 1
    status = .connecting
    let task = session.webSocketTask(with: address.socketURL)
    task.maximumMessageSize = Self.maxMessageBytes
    self.task = task
    task.resume()
    listen(on: task, generation: generation)
    handshakeTimer = Timer.scheduledTimer(withTimeInterval: Self.handshakeWithin, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self, !self.proven else { return }
        self.lost("KOS did not finish the handshake.")
      }
    }
  }

  private func hangUp(code: URLSessionWebSocketTask.CloseCode) {
    redial?.cancel()
    redial = nil
    pingTimer?.invalidate()
    pingTimer = nil
    handshakeTimer?.invalidate()
    handshakeTimer = nil
    let wasProven = proven
    proven = false
    generation += 1
    task?.cancel(with: code, reason: nil)
    task = nil
    if wasProven { onDrop?() }
  }

  private func lost(_ reason: String) {
    hangUp(code: .goingAway)
    status = .offline(reason)
    scheduleRedial()
  }

  private func scheduleRedial() {
    guard pairing != nil, !heldOff else { return }
    let delay = backoff.next()
    redial = Task { [weak self] in
      try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
      guard !Task.isCancelled else { return }
      self?.dial()
    }
  }

  private func networkChanged(up: Bool) {
    defer { pathWasDown = !up }
    guard up, pathWasDown, pairing != nil, !proven, !heldOff else { return }
    redialNow()
  }

  // MARK: Receiving

  private func listen(on task: URLSessionWebSocketTask, generation: Int) {
    Task { [weak self] in
      while true {
        let message: URLSessionWebSocketTask.Message
        do {
          message = try await task.receive()
        } catch {
          guard let self, self.generation == generation else { return }
          // A close KOS sent explains itself in didCloseWith; anything else is a lost line.
          if task.closeCode == .invalid { self.lost(Self.describe(error)) }
          return
        }
        guard let self, self.generation == generation else { return }
        switch message {
        case .string(let text): self.handle(Data(text.utf8))
        case .data(let data): self.handle(data)
        @unknown default: break
        }
      }
    }
  }

  private func handle(_ data: Data) {
    guard let pairing, let task else { return }
    let message: Inbound
    do {
      message = try Inbound.decode(data)
    } catch {
      return
    }
    switch message {
    case .challenge(let version, let nonce):
      guard version == protocolVersion else {
        hangUp(code: .init(rawValue: Close.unsupported) ?? .protocolError)
        status = .outdated
        return
      }
      guard Handshake.isValidNonce(nonce), let key = try? pairing.signingKey(),
            let signature = try? key.sign(Handshake.devicePayload(hostNonce: nonce, deviceId: pairing.deviceId)) else {
        lost("KOS sent a challenge this app cannot answer.")
        return
      }
      deviceNonce = Handshake.makeNonce()
      let hello = try? Outbound.hello(
        device: pairing.deviceId, nonce: deviceNonce, signature: signature, app: Self.appInfo, state: state())
      if let hello { task.send(.string(String(decoding: hello, as: UTF8.self))) { _ in } }

    case .welcome(let name, let signature):
      guard !proven else { return }
      let payload = Handshake.hostPayload(deviceNonce: deviceNonce, deviceId: pairing.deviceId)
      guard let hostKey = try? pairing.pinnedHostKey(), hostKey.verify(signature: signature, payload: payload) else {
        // Not KOS, whatever its address says. Nothing it sends is acted on.
        hangUp(code: .init(rawValue: Close.unknownDevice) ?? .policyViolation)
        status = .untrusted
        scheduleRedial()
        return
      }
      proven = true
      handshakeTimer?.invalidate()
      backoff.reset()
      status = .connected(name: name)
      startPinging()

    case .call(let call):
      guard proven else { return }
      Task { [weak self] in
        guard let self, let reply = await self.onCall?(call) else { return }
        self.send(reply)
      }
    }
  }

  private func startPinging() {
    pingTimer = Timer.scheduledTimer(withTimeInterval: Self.pingEvery, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self, let task = self.task else { return }
        let generation = self.generation
        task.sendPing { error in
          guard error != nil else { return }
          Task { @MainActor in
            guard self.generation == generation else { return }
            self.lost("KOS stopped answering.")
          }
        }
      }
    }
  }

  fileprivate func closed(_ task: URLSessionWebSocketTask, code: Int) {
    guard task === self.task else { return }
    switch code {
    case Close.unknownDevice:
      hangUp(code: .normalClosure)
      pairing = nil
      status = .offline("This Mac was removed from KOS.")
      onRemoved?()
    case Close.replaced:
      hangUp(code: .normalClosure)
      status = .replaced
    case Close.unsupported:
      hangUp(code: .normalClosure)
      status = .outdated
      scheduleRedial()
    case Close.malformed:
      lost("KOS could not read this app's hello.")
    default:
      lost("The line to KOS closed.")
    }
  }

  private static func describe(_ error: Error) -> String {
    let nsError = error as NSError
    if nsError.domain == NSURLErrorDomain, nsError.code == NSURLErrorCannotConnectToHost || nsError.code == NSURLErrorTimedOut {
      return "KOS is not answering."
    }
    return error.localizedDescription
  }

  static var appInfo: AppInfo {
    let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.1.0"
    let os = ProcessInfo.processInfo.operatingSystemVersion
    return AppInfo(version: version, os: "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)")
  }
}

extension Connection: URLSessionWebSocketDelegate {
  nonisolated func urlSession(
    _ session: URLSession, webSocketTask: URLSessionWebSocketTask,
    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?
  ) {
    MainActor.assumeIsolated { self.closed(webSocketTask, code: closeCode.rawValue) }
  }
}
