import Foundation

/// A phone's request of the dashboard's own routes (docs/computer.md, The
/// dashboard's pages): a read of one the dashboard draws a page from, or one
/// of the few things the owner does there. KOS holds it to its list and
/// answers it as the dashboard's handler would, by the call number given.
public struct DashboardRequest: Encodable, Equatable, Sendable {
  public let call: Int
  /// GET for a read, POST for an action.
  public let method: String
  public let path: String
  public let query: [String: String]?
  public let body: JSONValue?

  public init(call: Int, method: String, path: String, query: [String: String]? = nil, body: JSONValue? = nil) {
    self.call = call
    self.method = method
    self.path = path
    self.query = query?.isEmpty == true ? nil : query
    self.body = body
  }

  public static let event = "dashboard.request"
}

/// What `dashboard.reply` carries: the route's status and JSON, its bytes as base64 with their type, or why KOS
/// would not ask it.
public struct DashboardReply: Decodable, Equatable, Sendable {
  public let call: Int
  public let status: Int?
  public let body: JSONValue?
  /// The bytes' media type, for a route that answers a file.
  public let type: String?
  public let data: String?
  public let error: String?

  public init(call: Int, status: Int? = nil, body: JSONValue? = nil, type: String? = nil, data: String? = nil, error: String? = nil) {
    self.call = call
    self.status = status
    self.body = body
    self.type = type
    self.data = data
    self.error = error
  }

  public static let method = "dashboard.reply"
}
