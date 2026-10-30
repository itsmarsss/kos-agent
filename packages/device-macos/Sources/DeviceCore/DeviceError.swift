/// The refusals the protocol names, so KOS can tell the owner why rather than that it failed.
public enum ErrorCode: String, Codable, Sendable {
  case noSession = "no_session"
  case paused
  case busy
  case denied
  case permission
  case secureInput = "secure_input"
  case hiddenApp = "hidden_app"
  case badRequest = "bad_request"
  case `internal`
}

/// A call refused: the code KOS reads and the sentence the owner reads.
public struct DeviceError: Error, Equatable, Sendable {
  public let code: ErrorCode
  public let message: String

  public init(_ code: ErrorCode, _ message: String) {
    self.code = code
    self.message = message
  }

  public static func badRequest(_ message: String) -> DeviceError {
    DeviceError(.badRequest, message)
  }
}
