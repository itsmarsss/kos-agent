import Foundation

/// What the dashboard hands a device to pair it: where KOS is and a one-time code.
public struct PairingLink: Equatable, Sendable {
  public static let scheme = "kos-device"

  public let address: KOSAddress
  public let code: String

  public init(address: KOSAddress, code: String) throws {
    self.address = address
    self.code = try Self.normalize(code: code)
  }

  /// `kos-device://pair?url=<KOS address>&code=<code>`, pasted or opened. Nothing for other text.
  public static func parse(_ text: String) throws -> PairingLink? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let parts = URLComponents(string: trimmed), parts.scheme?.lowercased() == scheme else { return nil }
    guard parts.host?.lowercased() == "pair" else {
      throw DeviceError.badRequest("That KOS Device link is not a pairing link.")
    }
    let items = parts.queryItems ?? []
    guard let url = items.first(where: { $0.name == "url" })?.value,
          let code = items.first(where: { $0.name == "code" })?.value else {
      throw DeviceError.badRequest("The pairing link is missing its address or code.")
    }
    return try PairingLink(address: KOSAddress(url), code: code)
  }

  /// Codes are letters and digits in groups; case and stray spaces do not matter.
  public static func normalize(code: String) throws -> String {
    let cleaned = code.uppercased().filter { !$0.isWhitespace }
    guard (4...32).contains(cleaned.count), cleaned.allSatisfy({ ($0.isASCII && ($0.isLetter || $0.isNumber)) || $0 == "-" }) else {
      throw DeviceError.badRequest("That code does not look like one KOS makes. It reads like K7QX-M2PA.")
    }
    return cleaned
  }
}
