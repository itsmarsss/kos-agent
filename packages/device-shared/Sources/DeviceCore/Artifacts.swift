import Foundation

/// The owner's artifacts as a phone reads them (docs/computer.md, A phone):
/// the list it picks from, one drawn for it, and the answer to a read its
/// window.kos made. Times are epoch milliseconds.
public struct ArtifactItem: Decodable, Equatable, Identifiable, Sendable {
  public let id: String
  public let title: String
  /// page, doc, deck or sheet.
  public let kind: String
  public let description: String?
  public let updatedAt: Double
  /// Whose it is: KOS's at the root, a project's or a blob's.
  public let place: ChatPlace?

  public init(id: String, title: String, kind: String, description: String? = nil, updatedAt: Double, place: ChatPlace? = nil) {
    self.id = id
    self.title = title
    self.kind = kind
    self.description = description
    self.updatedAt = updatedAt
    self.place = place
  }

  /// The method KOS calls with the list.
  public static let listMethod = "chat.artifacts"
}

/// What `chat.artifacts` carries.
public struct ArtifactList: Decodable, Equatable, Sendable {
  public let artifacts: [ArtifactItem]

  enum CodingKeys: String, CodingKey { case artifacts }

  // One by one: an item this app cannot read is left out, and the rest still come.
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    artifacts = (try c.decodeIfPresent([Lenient<ArtifactItem>].self, forKey: .artifacts) ?? []).compactMap(\.value)
  }
}

/// What `chat.artifact` carries: the artifact drawn as the dashboard's frame, read-only, or why it is not.
public struct ArtifactOpened: Decodable, Equatable, Sendable {
  public let id: String?
  public let title: String?
  public let kind: String?
  public let place: ChatPlace?
  public let updatedAt: Double?
  /// The wrapper document holding the page's own, built by KOS.
  public let document: String?
  /// Each theme's tokens, as the rule the page's bridge takes on a change of theme.
  public let themes: Themes?
  /// The theme the document was drawn in.
  public let theme: String?
  public let error: String?

  public struct Themes: Decodable, Equatable, Sendable {
    public let light: String
    public let dark: String

    public init(light: String, dark: String) {
      self.light = light
      self.dark = dark
    }
  }

  public init(
    id: String?, title: String? = nil, kind: String? = nil, place: ChatPlace? = nil, updatedAt: Double? = nil, document: String? = nil,
    themes: Themes? = nil, theme: String? = nil, error: String? = nil
  ) {
    self.id = id
    self.title = title
    self.kind = kind
    self.place = place
    self.updatedAt = updatedAt
    self.document = document
    self.themes = themes
    self.theme = theme
    self.error = error
  }

  public static let method = "chat.artifact"
}

/// What `chat.read` carries: the answer to one read an open artifact made, by the call it was.
public struct ArtifactReadAnswer: Decodable, Equatable, Sendable {
  public let artifact: String
  public let call: Int
  public let result: JSONValue?
  public let error: String?

  public static let method = "chat.read"
}

/// One part of a file sent ahead of the words it goes with (`chat.attach`).
public struct AttachmentPart: Encodable, Equatable, Sendable {
  public let id: String
  public let name: String
  public let mediaType: String
  public let part: Int
  public let parts: Int
  /// This part of the file's base64.
  public let data: String

  /// Base64 characters in one part, as KOS takes them: inside a phone's 512 KB frame with room to spare.
  public static let chars = 256 * 1024

  /// A file's base64 as the parts it goes in.
  public static func parts(id: String, name: String, mediaType: String, bytes: Data) -> [AttachmentPart] {
    let base64 = Array(bytes.base64EncodedString().utf8)
    let count = max(1, (base64.count + chars - 1) / chars)
    return (0..<count).map { i in
      let slice = base64[min(i * chars, base64.count)..<min((i + 1) * chars, base64.count)]
      return AttachmentPart(id: id, name: name, mediaType: mediaType, part: i, parts: count, data: String(decoding: slice, as: UTF8.self))
    }
  }
}

/// Any JSON, carried through as it is: what a page asks and what KOS answers it.
public enum JSONValue: Codable, Equatable, Sendable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  public init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() {
      self = .null
    } else if let b = try? c.decode(Bool.self) {
      self = .bool(b)
    } else if let n = try? c.decode(Double.self) {
      self = .number(n)
    } else if let s = try? c.decode(String.self) {
      self = .string(s)
    } else if let a = try? c.decode([JSONValue].self) {
      self = .array(a)
    } else {
      self = .object(try c.decode([String: JSONValue].self))
    }
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .null: try c.encodeNil()
    case .bool(let b): try c.encode(b)
    case .number(let n): try c.encode(n)
    case .string(let s): try c.encode(s)
    case .array(let a): try c.encode(a)
    case .object(let o): try c.encode(o)
    }
  }

  /// Read from JSON text; nil when it is not JSON.
  public init?(json: Data) {
    guard let value = try? JSONDecoder().decode(JSONValue.self, from: json) else { return nil }
    self = value
  }

  /// As JSON text.
  public var json: Data { (try? JSONEncoder().encode(self)) ?? Data("null".utf8) }
}

/// One element of a list, or nothing when it does not read, so the list around it still does.
struct Lenient<Value: Decodable>: Decodable {
  let value: Value?

  init(from decoder: Decoder) throws {
    value = try? Value(from: decoder)
  }
}
