import DeviceCore
import Foundation

/// Pairing: this device's new public key and the owner's one-time code, for KOS's key in return.
public enum PairingClient {
  private struct Request: Encodable {
    let code: String
    let name: String
    let platform: String
    let publicKey: String
  }

  private struct Response: Decodable {
    let device: String
    let hostKey: String
    let protocolVersion: Int
    enum CodingKeys: String, CodingKey {
      case device, hostKey
      case protocolVersion = "protocol"
    }
  }

  private struct Failure: Decodable {
    let error: String
  }

  private struct Hello: Decodable {
    let kos: Bool
    let protocolVersion: Int
    enum CodingKeys: String, CodingKey {
      case kos
      case protocolVersion = "protocol"
    }
  }

  /// Pairs with the KOS the link names, as `platform` ("macos", "ios"). With a pin, from the link or from a
  /// `probe` the owner checked, the request goes only to the certificate pinned, and the pairing keeps it.
  public static func pair(_ link: PairingLink, name: String, platform: String, pin: String? = nil) async throws -> Pairing {
    let pin = pin ?? link.pin
    let key = DeviceKey()
    var request = URLRequest(url: link.address.pairURL, timeoutInterval: 20)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.httpBody = try JSONEncoder().encode(Request(code: link.code, name: name, platform: platform, publicKey: key.publicKeyBase64))

    let (data, status) = try await fetch(request, pin: pin, at: link.address)
    guard status == 200 else {
      if status == 403 { throw DeviceError(.denied, "That code is wrong, used or expired. Make a new one in KOS.") }
      if status == 429 { throw DeviceError(.denied, "Too many tries. Wait a minute, then try again.") }
      let said = (try? JSONDecoder().decode(Failure.self, from: data))?.error
      throw DeviceError(.internal, "KOS did not pair: \(said ?? "status \(status)").")
    }
    guard let answer = try? JSONDecoder().decode(Response.self, from: data) else {
      throw DeviceError(.internal, "KOS answered in a way this app does not read. Is the address KOS?")
    }
    guard answer.protocolVersion == protocolVersion else {
      throw DeviceError(.internal, "This KOS speaks device protocol \(answer.protocolVersion); this app speaks \(protocolVersion).")
    }
    let hostKey = try HostKey(base64: answer.hostKey)
    return Pairing(
      deviceId: answer.device, address: link.address.base.absoluteString, hostKey: hostKey.base64,
      deviceKey: key.rawRepresentation, name: name, pin: pin)
  }

  /// The pin of the certificate a KOS on the local network shows, asked before any code is sent: the owner
  /// checks its words against the ones KOS shows, and only then is the code sent, to that certificate alone.
  public static func probe(_ address: KOSAddress) async throws -> String {
    var request = URLRequest(url: address.lanURL, timeoutInterval: 10)
    request.httpMethod = "GET"
    let seen = SeenPin()
    let session = URLSession(configuration: .ephemeral, delegate: seen, delegateQueue: nil)
    defer { session.finishTasksAndInvalidate() }
    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(for: request)
    } catch {
      throw unreachable(address, error)
    }
    guard (response as? HTTPURLResponse)?.statusCode == 200,
          let hello = try? JSONDecoder().decode(Hello.self, from: data), hello.kos else {
      throw DeviceError(
        .internal, "Something answers at \(address.display), but it is not KOS's listener for phones. Check the address in KOS, Settings, Devices.")
    }
    guard hello.protocolVersion == protocolVersion else {
      throw DeviceError(.internal, "This KOS speaks device protocol \(hello.protocolVersion); this app speaks \(protocolVersion).")
    }
    guard let pin = seen.pin else { throw DeviceError(.internal, "KOS at \(address.display) showed no certificate.") }
    return pin
  }

  private static func fetch(_ request: URLRequest, pin: String?, at address: KOSAddress) async throws -> (Data, Int) {
    let box = PinBox()
    box.pin = pin
    let session = URLSession(configuration: .ephemeral, delegate: Pinned(box: box), delegateQueue: nil)
    defer { session.finishTasksAndInvalidate() }
    do {
      let (data, response) = try await session.data(for: request)
      return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
    } catch {
      if box.tookRefusal() {
        throw DeviceError(.denied, "KOS at \(address.display) did not show the certificate it showed before. Make a new code in KOS and pair again.")
      }
      throw unreachable(address, error)
    }
  }

  private static func unreachable(_ address: KOSAddress, _ error: Error) -> DeviceError {
    DeviceError(.internal, "Could not reach KOS at \(address.display): \(error.localizedDescription)")
  }
}

/// A session's trust held to a pin, or to the system's checks without one.
private final class Pinned: NSObject, URLSessionDelegate, @unchecked Sendable {
  let box: PinBox

  init(box: PinBox) {
    self.box = box
  }

  func urlSession(
    _ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    let (disposition, credential) = box.answer(challenge)
    completionHandler(disposition, credential)
  }
}

/// A session that takes whatever certificate it is shown, once, to learn its pin. It carries nothing secret:
/// the probe only asks whether KOS is there.
private final class SeenPin: NSObject, URLSessionDelegate, @unchecked Sendable {
  private let lock = NSLock()
  private var seen: String?

  var pin: String? { lock.withLock { seen } }

  func urlSession(
    _ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
          let trust = challenge.protectionSpace.serverTrust, let pin = ServerTrust.pinOf(trust) else {
      return completionHandler(.performDefaultHandling, nil)
    }
    lock.withLock { seen = pin }
    completionHandler(.useCredential, URLCredential(trust: trust))
  }
}
