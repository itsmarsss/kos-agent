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
  /// keys.secret: the app in front is not the one approved, or not one the secret allows, or is KOS for Mac.
  case target
  /// keys.secret: the page in the browser in front is not on the site approved.
  case origin
  /// keys.secret: the field with focus is not a text field of the kind the secret goes into, or not the one approved.
  case field
  /// A field KOS typed a secret into is in the way: focused and not found for a picture, or asked to copy or type.
  case secretField = "secret_field"
  /// keys.secret: stopped after part of the secret went in; the message says how much.
  case partial
  /// clipboard.read: an item on the clipboard is marked concealed, transient or auto-generated.
  case concealed
  /// clipboard.read: something else was copied since the owner was shown the preview.
  case changed
  /// vault.key, vault.unwrap: asked by a KOS that does not run on this Mac.
  case notHere = "not_here"
  /// vault.unwrap: the slot was sealed to another Mac's vault key.
  case key
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
