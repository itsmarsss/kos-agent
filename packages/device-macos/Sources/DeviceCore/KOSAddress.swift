import Foundation

/// Where KOS is, checked for a path the screen can safely travel over.
///
/// What crosses the connection is a picture of the owner's screen and the
/// keys typed on it. So it goes encrypted: https anywhere, and plain http
/// only where the network already is private and encrypted, which is this
/// Mac itself or a Tailscale tailnet.
public struct KOSAddress: Equatable, Sendable {
  /// The base address, with no trailing slash, query or fragment.
  public let base: URL

  public init(_ text: String) throws {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard var parts = URLComponents(string: Self.withScheme(trimmed)), let scheme = parts.scheme?.lowercased(),
          let host = parts.host?.lowercased(), !host.isEmpty else {
      throw DeviceError.badRequest("That is not an address. Paste the one KOS showed, like https://kos.example.ts.net.")
    }
    guard parts.user == nil, parts.password == nil else {
      throw DeviceError.badRequest("Leave the name and password out of the address.")
    }
    switch scheme {
    case "https":
      break
    case "http":
      guard Self.isPrivatePath(host) else {
        throw DeviceError.badRequest(
          "Plain http only works for this Mac or a Tailscale address. Put KOS behind https, or use its tailnet name.")
      }
    default:
      throw DeviceError.badRequest("The address must start with https:// or http://.")
    }
    parts.scheme = scheme
    parts.query = nil
    parts.fragment = nil
    while parts.path.hasSuffix("/") { parts.path.removeLast() }
    guard let url = parts.url else { throw DeviceError.badRequest("That is not an address.") }
    base = url
  }

  /// What the menu shows: the host and port, without the scheme.
  public var display: String {
    guard let host = base.host else { return base.absoluteString }
    return base.port.map { "\(host):\($0)" } ?? host
  }

  public var pairURL: URL { base.appendingPathComponent("api/devices/pair") }

  public var socketURL: URL {
    var parts = URLComponents(url: base.appendingPathComponent("api/devices/socket"), resolvingAgainstBaseURL: false)!
    parts.scheme = parts.scheme == "https" ? "wss" : "ws"
    return parts.url!
  }

  /// An address typed without a scheme: http where that is allowed, https everywhere else.
  private static func withScheme(_ text: String) -> String {
    guard !text.contains("://") else { return text }
    let host = URLComponents(string: "http://\(text)")?.host?.lowercased() ?? ""
    return "\(isPrivatePath(host) ? "http" : "https")://\(text)"
  }

  /// Loopback, a Tailscale address (100.64.0.0/10, fd7a:115c:a1e0::/48) or a tailnet name.
  static func isPrivatePath(_ host: String) -> Bool {
    let bare = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
    if bare == "localhost" || bare == "::1" || bare.hasSuffix(".ts.net") { return true }
    if bare.hasPrefix("fd7a:115c:a1e0:") { return true }
    let octets = bare.split(separator: ".").compactMap { UInt8($0) }
    guard octets.count == 4, bare.split(separator: ".").count == 4 else { return false }
    if octets[0] == 127 { return true }
    return octets[0] == 100 && (64...127).contains(octets[1])
  }
}
