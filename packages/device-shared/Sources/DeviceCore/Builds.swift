@preconcurrency import CryptoKit
import Foundation

/// Which build of the app this is, as its build stamped it (docs/computer.md,
/// Builds and updates): the hash of what it was made from, the commit of the
/// checkout that built it, and when. Said to KOS in every hello.
public struct Build: Codable, Equatable, Sendable {
  public let id: String
  public let commit: String
  /// Epoch milliseconds.
  public let builtAt: Double?

  public init(id: String, commit: String, builtAt: Double? = nil) {
    self.id = id
    self.commit = commit
    self.builtAt = builtAt
  }

  /// The stamp the build put in the app's resources, `build.json`; none in a build from before stamps, or one run from `swift run`.
  public static func stamped(in bundle: Bundle = .main) -> Build? {
    guard let url = bundle.url(forResource: "build", withExtension: "json"), let data = try? Data(contentsOf: url) else { return nil }
    return read(data)
  }

  /// A stamp as JSON, checked as KOS checks one: twelve hex digits of id, and a commit of forty or none.
  public static func read(_ data: Data) -> Build? {
    guard let build = try? JSONDecoder().decode(Build.self, from: data), build.isValid else { return nil }
    return build
  }

  var isValid: Bool {
    let hex = CharacterSet(charactersIn: "0123456789abcdef")
    let isHex = { (s: String) in s.unicodeScalars.allSatisfy(hex.contains) }
    return id.count == 12 && isHex(id) && (commit.isEmpty || (commit.count == 40 && isHex(commit)))
  }

  /// The commit as the owner reads it, seven digits; the id when it was built outside a checkout.
  public var short: String { commit.isEmpty ? id : String(commit.prefix(7)) }
}

/// What KOS says of this app's build, after the welcome and whenever it changes.
public struct UpdateNotice: Equatable, Sendable {
  public enum State: String, Sendable {
    case current, behind, updating, unknown
  }

  /// Why it is where it is; one this app does not know reads as none.
  public enum Reason: String, Sendable {
    /// KOS has no build of its own to hand it.
    case unbuilt
    /// This app said no build.
    case unstamped
    /// It runs on another computer than KOS's.
    case remote
    /// KOS waits for no session and no turn on it.
    case idle
    /// KOS for Mac's signing key is not set up, so a rebuild would cost its permissions.
    case signing
    /// An iPhone updates from Xcode.
    case xcode
    /// The owner turned updating on their own off.
    case off
    /// The last try did not finish.
    case failed
    /// Rebuilt, and back on the old build.
    case stuck
  }

  public let state: State
  /// The build KOS would hand it.
  public let build: Build?
  public let reason: Reason?
  /// The last line of a failed update.
  public let detail: String?
  /// What the owner runs by hand: to set signing up, or to update it themselves.
  public let command: String?

  public init(state: State, build: Build? = nil, reason: Reason? = nil, detail: String? = nil, command: String? = nil) {
    self.state = state
    self.build = build
    self.reason = reason
    self.detail = detail
    self.command = command
  }

  /// Which notice this is, to be put away once: the build it is for and why.
  public var key: String { "\(build?.id ?? "-"):\(state.rawValue):\(reason?.rawValue ?? "-")" }
}

/// How a device on the computer KOS runs on proves it is there (docs/computer.md,
/// Builds and updates): the secret KOS keeps in a file only the owner can read,
/// as HMAC-SHA256 over KOS's nonce bound to this device's id. KOS rebuilds a Mac
/// only when it proves this; a device elsewhere cannot read the file.
public enum HereProof {
  /// Where KOS keeps the secret, beside its own key.
  public static var keyFile: URL {
    FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".kos/device-local.key")
  }

  /// The proof for one hello; none when there is no secret to read, as on another computer.
  public static func sign(hostNonce: String, deviceId: String, keyFile: URL = keyFile) -> String? {
    guard let text = try? String(contentsOf: keyFile, encoding: .utf8),
          let key = Data(base64Encoded: text.trimmingCharacters(in: .whitespacesAndNewlines)), key.count == 32 else { return nil }
    let mac = HMAC<SHA256>.authenticationCode(for: Data("kos-device/1|here|\(hostNonce)|\(deviceId)".utf8), using: SymmetricKey(data: key))
    return Data(mac).base64EncodedString()
  }
}
