import DeviceCore
import DeviceLink
import Foundation

/// Pairing with a KOS, the way KOS for Mac does (a code and a key), over the
/// home Wi-Fi: KOS's listener there shows a certificate KOS made itself, so
/// the phone holds KOS to it by its pin. A pairing link carries the pin; an
/// address and a code typed by hand are checked first. Either way the owner
/// compares the certificate's words with the ones KOS shows before the code
/// is sent, and a link, which anything on the phone can open, never pairs
/// without the owner saying so: while paired, it asks to replace the pairing
/// first.
@MainActor
public final class PairingFlow: ObservableObject {
  public enum Step: Equatable, Sendable {
    case enter
    /// A link while paired: the owner says whether this KOS takes the pairing's place.
    case replace(Entered)
    /// Asking KOS for its certificate, before any code is sent.
    case checking
    /// The owner compares these words with the ones KOS shows, or, for a KOS with no pin, says to pair with it.
    case confirm(Check)
    case pairing
  }

  /// What was entered, read: the KOS to pair with, and whether a link said so rather than the owner's typing.
  public struct Entered: Equatable, Sendable {
    public let link: PairingLink
    public let fromLink: Bool
  }

  /// A KOS to pair with, before the code goes: its certificate's pin and words when it is reached on the local
  /// network, none for one a certificate authority vouches for.
  public struct Check: Equatable, Sendable {
    public let link: PairingLink
    public let pin: String?
    public let words: String?
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
  /// The address of the KOS this phone is paired with now, none before it is.
  public var current: () -> String? = { nil }

  private let pairer: Pairer
  /// Each certificate asked for, counted, so only the latest one's answer is shown.
  private var probes = 0

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

  /// Between entering and pairing: a step the owner answers, or one waiting on KOS.
  public var underway: Bool { step != .enter }

  /// A pairing link opened from elsewhere (the dashboard on this phone, a message): read as if pasted, and
  /// confirmed by the owner before anything is sent. One opened while another is being asked about, checked
  /// or paired is let go: the owner answers what is in front of them, never a step swapped under them.
  public func open(_ url: URL) async {
    guard url.scheme?.lowercased() == PairingLink.scheme, step == .enter else { return }
    address = url.absoluteString
    code = ""
    await next()
  }

  /// On from what was entered: while paired, the owner first says to replace the pairing; then the KOS is
  /// confirmed, by its certificate's words when it has one.
  public func next() async {
    guard step == .enter else { return }
    error = nil
    let entered: Entered
    do {
      entered = try read()
    } catch {
      return fail(error)
    }
    if current() != nil {
      step = .replace(entered)
    } else {
      await check(entered)
    }
  }

  /// The owner said this KOS takes the pairing's place: on to its confirmation.
  public func replace() async {
    guard case .replace(let entered) = step else { return }
    await check(entered)
  }

  /// The words matched, or the owner said to pair: the code goes to that certificate alone, and the pairing keeps its pin.
  public func confirm() async {
    guard case .confirm(let check) = step else { return }
    await pair(check.link, pin: check.pin)
  }

  /// A link's pin is its words; a KOS on the local network shows its certificate first; one a certificate
  /// authority vouches for is confirmed when a link named it, and paired at once when the owner typed it.
  private func check(_ entered: Entered) async {
    let link = entered.link
    if let pin = link.pin {
      step = .confirm(Check(link: link, pin: pin, words: CertificatePin.words(pin) ?? pin))
      return
    }
    guard link.address.isLocalNetwork else {
      if entered.fromLink {
        step = .confirm(Check(link: link, pin: nil, words: nil))
      } else {
        await pair(link, pin: nil)
      }
      return
    }
    step = .checking
    probes += 1
    let probe = probes
    do {
      let pin = try await pairer.probe(link.address)
      // Gone back and checking another KOS since: this answer is that one's no longer.
      guard step == .checking, probe == probes else { return }
      step = .confirm(Check(link: link, pin: pin, words: CertificatePin.words(pin) ?? pin))
    } catch {
      guard step == .checking, probe == probes else { return }
      fail(error)
    }
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

  /// Put away: nothing entered or said stays for the next time.
  public func dismiss() {
    step = .enter
    address = ""
    code = ""
    error = nil
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
  private func read() throws -> Entered {
    let typed = address.trimmingCharacters(in: .whitespacesAndNewlines)
    if let link = try PairingLink.parse(typed) { return Entered(link: link, fromLink: true) }
    guard !typed.isEmpty else { throw DeviceError.badRequest("Paste the pairing link, or type KOS's address.") }
    guard !code.trimmingCharacters(in: .whitespaces).isEmpty else {
      throw DeviceError.badRequest("Type the code KOS shows under Settings, Devices, Add a device.")
    }
    var text = typed
    if text.lowercased().hasPrefix("http://"), let local = try? KOSAddress("https://" + text.dropFirst(7)), local.isLocalNetwork {
      text = local.base.absoluteString
    }
    return Entered(link: try PairingLink(address: KOSAddress(text), code: code), fromLink: false)
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
