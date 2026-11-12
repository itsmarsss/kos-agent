@preconcurrency import CryptoKit
import Foundation

/// A KOS's own TLS certificate, known by its hash rather than by a
/// certificate authority: what a phone on the home Wi-Fi holds KOS to.
///
/// KOS's listener on the local network serves a certificate it made itself
/// (docs/computer.md, The local network). The pairing link carries the
/// certificate's pin, and a code typed by hand is sent only once the owner
/// has seen the pin's words match the ones KOS shows. From then on every
/// connection must show that same certificate, or it is not KOS.
public enum CertificatePin {
  /// The pin of a certificate: SHA-256 of its DER bytes, as unpadded base64url.
  public static func of(der: Data) -> String {
    base64url(Data(SHA256.hash(data: der)))
  }

  /// Whether text reads as a pin: 32 bytes of unpadded base64url.
  public static func isValid(_ pin: String) -> Bool {
    bytes(pin)?.count == 32
  }

  /// What the owner compares by eye: the first eight bytes of the hash, in hex, in four groups, as KOS shows them.
  public static func words(_ pin: String) -> String? {
    guard let bytes = bytes(pin), bytes.count == 32 else { return nil }
    let hex = bytes.prefix(8).map { String(format: "%02X", $0) }.joined()
    return stride(from: 0, to: hex.count, by: 4).map { at in
      let start = hex.index(hex.startIndex, offsetBy: at)
      return String(hex[start..<hex.index(start, offsetBy: 4)])
    }.joined(separator: " ")
  }

  private static func base64url(_ data: Data) -> String {
    data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  private static func bytes(_ pin: String) -> Data? {
    guard !pin.isEmpty, pin.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else { return nil }
    var text = pin.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    text += String(repeating: "=", count: (4 - text.count % 4) % 4)
    return Data(base64Encoded: text)
  }
}
