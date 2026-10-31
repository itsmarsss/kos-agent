import Foundation

/// The protocol version this device speaks (docs/computer.md).
public let protocolVersion = 1

/// Who allows a session: the owner on this device, or KOS's approval queue.
public enum Consent: String, Codable, Sendable {
  case device
  case kos
}

public struct Permissions: Codable, Equatable, Sendable {
  public var screen: Bool
  public var input: Bool

  public init(screen: Bool, input: Bool) {
    self.screen = screen
    self.input = input
  }
}

/// A display as KOS sees it: its size in points and how many pixels each point is.
public struct DisplayInfo: Codable, Equatable, Sendable {
  public var id: UInt32
  public var width: Double
  public var height: Double
  public var scale: Double
  public var main: Bool

  public init(id: UInt32, width: Double, height: Double, scale: Double, main: Bool) {
    self.id = id
    self.width = width
    self.height = height
    self.scale = scale
    self.main = main
  }
}

public struct AppInfo: Codable, Equatable, Sendable {
  public var version: String
  public var platform: String
  public var os: String

  public init(version: String, platform: String = "macos", os: String) {
    self.version = version
    self.platform = platform
    self.os = os
  }
}

/// What the device tells KOS about itself, in the hello and again whenever it changes.
public struct DeviceState: Equatable, Sendable {
  public var consent: Consent
  public var permissions: Permissions
  public var displays: [DisplayInfo]

  public init(consent: Consent, permissions: Permissions, displays: [DisplayInfo]) {
    self.consent = consent
    self.permissions = permissions
    self.displays = displays
  }
}

/// A message from KOS.
public enum Inbound: Equatable {
  case challenge(protocol: Int, nonce: String)
  case welcome(name: String, signature: String)
  case call(Call)

  public static func decode(_ data: Data) throws -> Inbound {
    let decoder = JSONDecoder()
    let kind = try decoder.decode(Kind.self, from: data).t
    switch kind {
    case "challenge":
      let m = try decoder.decode(ChallengeBody.self, from: data)
      return .challenge(protocol: m.protocolVersion, nonce: m.nonce)
    case "welcome":
      let m = try decoder.decode(WelcomeBody.self, from: data)
      return .welcome(name: m.name, signature: m.signature)
    case "call":
      let m = try decoder.decode(CallHeader.self, from: data)
      return .call(Call(id: m.id, method: m.method, raw: data))
    default:
      throw DeviceError.badRequest("Unknown message type \(kind).")
    }
  }

  private struct Kind: Decodable { let t: String }

  private struct ChallengeBody: Decodable {
    let protocolVersion: Int
    let nonce: String
    enum CodingKeys: String, CodingKey {
      case protocolVersion = "protocol"
      case nonce
    }
  }

  private struct WelcomeBody: Decodable {
    let name: String
    let signature: String
  }

  private struct CallHeader: Decodable {
    let id: Int
    let method: String
  }
}

/// A call from KOS. Its params are read once the method is known, so a bad
/// param is answered as a bad request on that call rather than dropped.
public struct Call: Equatable {
  public let id: Int
  public let method: String
  let raw: Data

  public func params<P: Decodable>(_ type: P.Type) throws -> P {
    do {
      return try JSONDecoder().decode(Envelope<P>.self, from: raw).params
    } catch let error as DecodingError {
      throw DeviceError.badRequest("Bad params for \(method): \(Self.describe(error))")
    }
  }

  private struct Envelope<P: Decodable>: Decodable { let params: P }

  private static func describe(_ error: DecodingError) -> String {
    switch error {
    case .keyNotFound(let key, _): return "\(key.stringValue) is missing."
    case .typeMismatch(_, let context), .valueNotFound(_, let context), .dataCorrupted(let context):
      let path = context.codingPath.map(\.stringValue).filter { $0 != "params" }.joined(separator: ".")
      return path.isEmpty ? context.debugDescription : "\(path) is not valid."
    @unknown default: return "unreadable."
    }
  }
}

/// A message to KOS.
public enum Outbound {
  public static func hello(device: String, nonce: String, signature: String, app: AppInfo, state: DeviceState) throws -> Data {
    try encode(HelloBody(
      protocolVersion: protocolVersion, device: device, nonce: nonce, signature: signature, app: app,
      consent: state.consent, permissions: state.permissions, displays: state.displays))
  }

  public static func state(_ state: DeviceState) throws -> Data {
    try encode(StateBody(consent: state.consent, permissions: state.permissions, displays: state.displays))
  }

  public static func reply<R: Encodable>(id: Int, result: R) throws -> Data {
    try encode(ReplyOK(id: id, result: result))
  }

  public static func reply(id: Int, error: DeviceError) throws -> Data {
    try encode(ReplyError(id: id, error: .init(code: error.code, message: error.message)))
  }

  public static func event<D: Encodable>(_ name: EventName, data: D) throws -> Data {
    try encode(EventBody(name: name.rawValue, data: data))
  }

  /// The owner unpaired this device here: the KOS on this line forgets it too.
  public static func unpair() throws -> Data {
    try encode(UnpairBody())
  }

  private struct UnpairBody: Encodable {
    let t = "unpair"
  }

  private static func encode<T: Encodable>(_ value: T) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    return try encoder.encode(value)
  }

  private struct HelloBody: Encodable {
    let t = "hello"
    let protocolVersion: Int
    let device: String
    let nonce: String
    let signature: String
    let app: AppInfo
    let consent: Consent
    let permissions: Permissions
    let displays: [DisplayInfo]
    enum CodingKeys: String, CodingKey {
      case t, device, nonce, signature, app, consent, permissions, displays
      case protocolVersion = "protocol"
    }
  }

  private struct StateBody: Encodable {
    let t = "state"
    let consent: Consent
    let permissions: Permissions
    let displays: [DisplayInfo]
  }

  private struct ReplyOK<R: Encodable>: Encodable {
    let t = "reply"
    let id: Int
    let ok = true
    let result: R
  }

  private struct ReplyError: Encodable {
    struct Body: Encodable {
      let code: ErrorCode
      let message: String
    }
    let t = "reply"
    let id: Int
    let ok = false
    let error: Body
  }

  private struct EventBody<D: Encodable>: Encodable {
    let t = "event"
    let name: String
    let data: D
  }
}
