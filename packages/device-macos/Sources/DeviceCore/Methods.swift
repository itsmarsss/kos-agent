import Foundation

/// The calls KOS may make (docs/computer.md, Calls).
public enum CallMethod: String, CaseIterable, Sendable {
  case sessionBegin = "session.begin"
  case sessionEnd = "session.end"
  case screenCapture = "screen.capture"
  case pointerMove = "pointer.move"
  case pointerClick = "pointer.click"
  case pointerDrag = "pointer.drag"
  case pointerScroll = "pointer.scroll"
  case keysType = "keys.type"
  case keysPress = "keys.press"
}

public enum EventName: String, Sendable {
  case sessionPaused = "session.paused"
  case sessionResumed = "session.resumed"
  case sessionExtended = "session.extended"
  case sessionEnded = "session.ended"
}

public enum MouseButton: String, Codable, Sendable {
  case left, right, middle
}

// MARK: Params

public struct SessionBeginParams: Decodable, Sendable {
  public let session: String
  public let task: String
  public let requester: String
  /// The chat asking, by id, so the owner can open it on the dashboard.
  public let conversation: String?
  public let minutes: Double
  public let maxEdge: Double?
}

public struct SessionRef: Decodable, Sendable {
  public let session: String
}

public struct CaptureParams: Decodable, Sendable {
  public let session: String
  public let region: Rect?
}

public struct MoveParams: Decodable, Sendable {
  public let session: String
  public let x: Double
  public let y: Double
}

public struct ClickParams: Decodable, Sendable {
  public let session: String
  public let x: Double
  public let y: Double
  public let button: MouseButton?
  public let count: Int?
  public let modifiers: [String]?
}

public struct DragParams: Decodable, Sendable {
  public let session: String
  public let from: Point
  public let to: Point
}

public struct ScrollParams: Decodable, Sendable {
  public let session: String
  public let x: Double
  public let y: Double
  public let dx: Double
  public let dy: Double
}

public struct TypeParams: Decodable, Sendable {
  public let session: String
  public let text: String
}

public struct PressParams: Decodable, Sendable {
  public let session: String
  public let keys: String
  public let `repeat`: Int?
}

// MARK: Results

public struct SessionBeginResult: Encodable, Sendable {
  public let granted = true
  /// When the session ends on its own, epoch milliseconds.
  public let until: Int64
  public let space: Size

  public init(until: Int64, space: Size) {
    self.until = until
    self.space = space
  }
}

public struct EmptyResult: Encodable, Sendable {
  public init() {}
}

public struct FrontApp: Codable, Equatable, Sendable {
  public let name: String
  public let bundle: String

  public init(name: String, bundle: String) {
    self.name = name
    self.bundle = bundle
  }
}

public struct CaptureResult: Encodable, Sendable {
  public let image: String
  public let mediaType: String
  public let width: Int
  public let height: Int
  public let cursor: Point
  public let app: FrontApp?

  public init(image: String, mediaType: String, width: Int, height: Int, cursor: Point, app: FrontApp?) {
    self.image = image
    self.mediaType = mediaType
    self.width = width
    self.height = height
    self.cursor = cursor
    self.app = app
  }
}

public struct CursorResult: Encodable, Sendable {
  public let cursor: Point

  public init(cursor: Point) {
    self.cursor = cursor
  }
}

// MARK: Events

public struct SessionPausedEvent: Encodable, Sendable {
  public let session: String
  public let reason = "owner"

  public init(session: String) {
    self.session = session
  }
}

public struct SessionResumedEvent: Encodable, Sendable {
  public let session: String

  public init(session: String) {
    self.session = session
  }
}

/// The owner gave the session more time; `until` in epoch milliseconds, as session.begin answers it.
public struct SessionExtendedEvent: Encodable, Sendable {
  public let session: String
  public let until: Int64

  public init(session: String, until: Date) {
    self.session = session
    self.until = Int64(until.timeIntervalSince1970 * 1000)
  }
}

public struct SessionEndedEvent: Encodable, Sendable {
  public let session: String
  public let reason: EndReason

  public init(session: String, reason: EndReason) {
    self.session = session
    self.reason = reason
  }
}

// MARK: Limits

public enum Limits {
  /// The longest text one keys.type may carry.
  public static let typedCharacters = 4000
  /// How many lines one scroll may move, either way.
  public static let scrollLines = 100.0
  /// How many times one keys.press may repeat its combination.
  public static let pressRepeats = 50
  /// The longest side of a capture when KOS names none.
  public static let defaultMaxEdge = 1280.0
  /// The bounds KOS may ask for in maxEdge.
  public static let maxEdgeRange = 320.0...2560.0
}
