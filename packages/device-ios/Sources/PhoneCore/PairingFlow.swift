import DeviceCore
import DeviceLink
import Foundation

/// Pairing with a KOS, the way KOS for Mac does (a code and a key), over the
/// home Wi-Fi: KOS's listener there shows a certificate KOS made itself, so
/// the phone holds KOS to it by its pin. A pairing link carries the pin; an
/// address and a code typed by hand are checked first, the owner comparing
/// the certificate's words with the ones KOS shows before the code is sent.
@MainActor
public final class PairingFlow: ObservableObject {
  public enum Step: Equatable, Sendable {
    case enter
    /// Asking KOS for its certificate, before any code is sent.
    case checking
    /// The owner compares these words with the ones KOS shows.
    case confirm(Check)
    case pairing
  }

  /// A KOS on the local network, its certificate seen and not yet trusted.
  public struct Check: Equatable, Sendable {
    public let link: PairingLink
    public let pin: String
    public let words: String
  }

  /// A pairing link, or KOS's address as Settings, Devices shows it.
  @Published public var address = "" { didSet { if address != oldValue { error = nil } } }
  @Published public var code = "" { didSet { if code != oldValue { error = nil } } }
  /// What this phone is called in KOS.
  @Published public var name: String
  @Published public private(set) var step: Step = .enter
  @Published public private(set) var error: String?

  /// A pairing made: the app keeps it and dials.
  public var paired: (Pairing) -> Void = { _ in }

  private let pairer: Pairer

  public init(pairer: Pairer, name: String = "iPhone") {
    self.pairer = pairer
    self.name = name
  }

  /// The link pasted or opened, else the address and the code typed, read enough to go on.
  public var canContinue: Bool {
    guard step == .enter else { return false }
    let typed = address.trimmingCharacters(in: .whitespacesAndNewlines)
    return (try? PairingLink.parse(typed)) != nil || (!typed.isEmpty && !code.trimmingCharacters(in: .whitespaces).isEmpty)
  }

  /// A pairing link opened from elsewhere (the dashboard on this phone, a message): read as if pasted.
  public func open(_ url: URL) async {
    guard url.scheme?.lowercased() == PairingLink.scheme else { return }
    step = .enter
    address = url.absoluteString
    code = ""
    await next()
  }

  /// On from what was entered: a link with a pin pairs at once; a KOS on the local network shows its
  /// certificate's words first; one a certificate authority vouches for pairs at once.
  public func next() async {
    guard step == .enter else { return }
    error = nil
    let link: PairingLink
    do {
      link = try read()
    } catch {
      return fail(error)
    }
    if link.pin != nil || !link.address.isLocalNetwork { return await pair(link, pin: link.pin) }
    step = .checking
    do {
      let pin = try await pairer.probe(link.address)
      guard step == .checking else { return }
      step = .confirm(Check(link: link, pin: pin, words: CertificatePin.words(pin) ?? pin))
    } catch {
      fail(error)
    }
  }

  /// The words matched: the code goes to that certificate alone, and the pairing keeps its pin.
  public func confirm() async {
    guard case .confirm(let check) = step else { return }
    await pair(check.link, pin: check.pin)
  }

  /// Something to say over the pairing screen: why the phone is back on it.
  public func note(_ words: String) {
    step = .enter
    error = words
  }

  /// Back to what was entered: the words did not match, or the owner thought again.
  public func back() {
    step = .enter
  }

  private func pair(_ link: PairingLink, pin: String?) async {
    step = .pairing
    let name = self.name.trimmingCharacters(in: .whitespaces)
    do {
      let pairing = try await pairer.pair(link, name: name.isEmpty ? "iPhone" : name, pin: pin)
      step = .enter
      address = ""
      code = ""
      paired(pairing)
    } catch {
      fail(error)
    }
  }

  private func fail(_ error: Error) {
    step = .enter
    self.error = (error as? DeviceError)?.message ?? error.localizedDescription
  }

  /// The pairing link pasted, or the address and code. KOS on the Wi-Fi speaks only https, so an http
  /// address there is read as the https one rather than refused.
  private func read() throws -> PairingLink {
    let typed = address.trimmingCharacters(in: .whitespacesAndNewlines)
    if let link = try PairingLink.parse(typed) { return link }
    guard !typed.isEmpty else { throw DeviceError.badRequest("Paste the pairing link, or type KOS's address.") }
    guard !code.trimmingCharacters(in: .whitespaces).isEmpty else {
      throw DeviceError.badRequest("Type the code KOS shows under Settings, Devices, Add a device.")
    }
    var text = typed
    if text.lowercased().hasPrefix("http://"), let local = try? KOSAddress("https://" + text.dropFirst(7)), local.isLocalNetwork {
      text = local.base.absoluteString
    }
    return try PairingLink(address: KOSAddress(text), code: code)
  }
}

/// Who pairs: PairingClient over the network, or a stand-in in a test.
public protocol Pairer: Sendable {
  /// The pin of the certificate the KOS at `address` shows, before any code is sent.
  func probe(_ address: KOSAddress) async throws -> String
  func pair(_ link: PairingLink, name: String, pin: String?) async throws -> Pairing
}

/// Pairing over the network, as this phone: platform "ios".
public struct NetworkPairer: Pairer {
  public init() {}

  public func probe(_ address: KOSAddress) async throws -> String {
    try await PairingClient.probe(address)
  }

  public func pair(_ link: PairingLink, name: String, pin: String?) async throws -> Pairing {
    try await PairingClient.pair(link, name: name, platform: Phone.platform, pin: pin)
  }
}
