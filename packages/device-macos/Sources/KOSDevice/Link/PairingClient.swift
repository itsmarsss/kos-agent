import DeviceCore
import Foundation

/// Pairing: this device's new public key and the owner's one-time code, for KOS's key in return.
enum PairingClient {
  private struct Request: Encodable {
    let code: String
    let name: String
    let platform = "macos"
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

  static func pair(_ link: PairingLink, name: String) async throws -> Pairing {
    let key = DeviceKey()
    var request = URLRequest(url: link.address.pairURL, timeoutInterval: 20)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.httpBody = try JSONEncoder().encode(Request(code: link.code, name: name, publicKey: key.publicKeyBase64))

    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await URLSession.shared.data(for: request)
    } catch {
      throw DeviceError(.internal, "Could not reach KOS at \(link.address.display): \(error.localizedDescription)")
    }
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard status == 200 else {
      if status == 403 { throw DeviceError(.denied, "That code is wrong, used or expired. Make a new one in KOS.") }
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
      deviceKey: key.rawRepresentation, name: name)
  }
}
