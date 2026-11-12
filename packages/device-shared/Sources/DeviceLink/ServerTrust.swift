import DeviceCore
import Foundation
import Security

/// How a line or a pairing request takes the certificate the far end shows.
///
/// With a pin, the certificate must be the one pinned, whoever signed it; no
/// certificate authority can vouch for another. Without one, the system's own
/// checks decide, as for any https site.
enum ServerTrust {
  static func answer(_ challenge: URLAuthenticationChallenge, pin: String?) -> (URLSession.AuthChallengeDisposition, URLCredential?) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
          let trust = challenge.protectionSpace.serverTrust else { return (.performDefaultHandling, nil) }
    guard let pin else { return (.performDefaultHandling, nil) }
    return pinOf(trust) == pin ? (.useCredential, URLCredential(trust: trust)) : (.cancelAuthenticationChallenge, nil)
  }

  /// The pin of the certificate the far end shows: its leaf's.
  static func pinOf(_ trust: SecTrust) -> String? {
    guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first else { return nil }
    return CertificatePin.of(der: SecCertificateCopyData(leaf) as Data)
  }
}

/// The pin a line holds its far end to, read from the session's own queue as each connection is checked.
final class PinBox: @unchecked Sendable {
  private let lock = NSLock()
  private var value: String?
  private var refusedOne = false

  var pin: String? {
    get { lock.withLock { value } }
    set { lock.withLock { value = newValue } }
  }

  /// Checks the far end's certificate against the pin, and remembers a refusal for the line to say why it dropped.
  func answer(_ challenge: URLAuthenticationChallenge) -> (URLSession.AuthChallengeDisposition, URLCredential?) {
    let answer = ServerTrust.answer(challenge, pin: pin)
    if answer.0 == .cancelAuthenticationChallenge { lock.withLock { refusedOne = true } }
    return answer
  }

  /// Whether a certificate was refused since this was last asked.
  func tookRefusal() -> Bool {
    lock.withLock {
      defer { refusedOne = false }
      return refusedOne
    }
  }
}
