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

  /// What KOS's listener on the local network answers before a code is sent, so its certificate can be checked.
  public var lanURL: URL { base.appendingPathComponent("api/devices/lan") }

  /// The dashboard's Devices page, where codes are made.
  public var devicesPage: URL { page("settings/devices") }

  /// A chat on the dashboard, by its id.
  public func chat(_ conversation: String) -> URL {
    page("chats/\(conversation.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_."))) ?? conversation)")
  }

  /// A page of the dashboard: its routes live after the hash.
  private func page(_ route: String) -> URL {
    var parts = URLComponents(url: base, resolvingAgainstBaseURL: false)!
    parts.path = "/"
    parts.percentEncodedFragment = "/\(route)"
    return parts.url ?? base
  }

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

  /// Whether the host is on the local network: a private IPv4 (10/8, 172.16/12, 192.168/16), a link-local one
  /// (169.254/16), an IPv6 unique-local or link-local address, or a `.local` name. KOS serves a certificate it
  /// made itself there, which a device holds it to by its pin.
  public var isLocalNetwork: Bool {
    guard let host = base.host?.lowercased() else { return false }
    let bare = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
    if bare.hasSuffix(".local") { return true }
    if bare.contains(":") {
      // A tailnet's own range is unique-local too, and is no local network.
      return bare.hasPrefix("fe80:") || ((bare.hasPrefix("fc") || bare.hasPrefix("fd")) && !bare.hasPrefix("fd7a:115c:a1e0:"))
    }
    let parts = bare.split(separator: ".", omittingEmptySubsequences: false)
    let octets = parts.compactMap { UInt8($0) }
    guard parts.count == 4, octets.count == 4 else { return false }
    switch (octets[0], octets[1]) {
    case (10, _), (192, 168), (169, 254): return true
    case (172, let b): return (16...31).contains(b)
    default: return false
    }
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
