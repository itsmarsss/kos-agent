import DeviceCore
import Foundation
import OSLog

/// The dashboard's own routes, asked over the line (docs/computer.md, The
/// dashboard's pages): every page the phone has reads through here, and the
/// few things the owner does from one go through here too. A request goes by
/// a call number of the phone's own and its answer comes back by it; one KOS
/// does not answer in time is given up on, and one asked off the line fails
/// at once.
@MainActor
public final class Dashboard {
  /// Why a page could not be read or a thing done, in the owner's words.
  public struct Refusal: Error, Equatable, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
  }

  /// What the phone says to KOS, and whether it could: the app sends it on the line.
  public var tell: (ChatEvent) -> Bool = { _ in false }

  private static let log = Logger(subsystem: "com.itsmarsss.kos-phone", category: "dashboard")
  private var calls = 0
  private var waiting: [Int: CheckedContinuation<DashboardReply, Never>] = [:]
  private let within: Duration
  private let sleep: @Sendable (Duration) async -> Void

  /// A file of a few megabytes can take a while over the Wi-Fi, so a call waits longer than a read in an artifact.
  public init(within: Duration = .seconds(25), sleep: @escaping @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) }) {
    self.within = within
    self.sleep = sleep
  }

  /// A route's JSON, decoded.
  public func get<Value: Decodable>(_ type: Value.Type, _ path: String, query: [String: String] = [:]) async throws -> Value {
    try decode(type, try await json("GET", path, query: query))
  }

  /// One of the things the owner does on the dashboard; its answer, as JSON.
  @discardableResult
  public func post(_ path: String, body: JSONValue = .object([:])) async throws -> JSONValue {
    try await json("POST", path, body: body)
  }

  /// A route that answers a file: its bytes and their type.
  public func bytes(_ path: String, query: [String: String] = [:]) async throws -> (type: String, data: Data) {
    let reply = try await ask(DashboardRequest(call: next(), method: "GET", path: path, query: query))
    guard let data = reply.data.flatMap({ Data(base64Encoded: $0) }), let type = reply.type else {
      throw Refusal(reply.body.flatMap(Self.words) ?? "KOS sent that file in a shape this app does not read.")
    }
    return (type, data)
  }

  /// KOS's answer, to the request it is for.
  public func received(_ reply: DashboardReply) {
    waiting.removeValue(forKey: reply.call)?.resume(returning: reply)
  }

  /// Off the line, or another KOS: nothing asked of the last one is waited on.
  public func reset() {
    let left = waiting
    waiting = [:]
    for (call, wait) in left { wait.resume(returning: DashboardReply(call: call, error: "The line to KOS closed.")) }
  }

  private func json(_ method: String, _ path: String, query: [String: String] = [:], body: JSONValue? = nil) async throws -> JSONValue {
    let reply = try await ask(DashboardRequest(call: next(), method: method, path: path, query: query, body: body))
    return reply.body ?? .null
  }

  private func next() -> Int {
    calls += 1
    return calls
  }

  /// Asked, and waited on until KOS answers, the wait runs out, or the line closes; any answer but a good one throws.
  private func ask(_ request: DashboardRequest) async throws -> DashboardReply {
    let reply = await withCheckedContinuation { wait in
      waiting[request.call] = wait
      guard tell(.dashboard(request)) else { return received(DashboardReply(call: request.call, error: "Not connected to KOS.")) }
      let sleep = sleep, within = within
      Task { [weak self] in
        await sleep(within)
        self?.received(DashboardReply(call: request.call, error: "KOS didn't answer in time. Try again."))
      }
    }
    if let error = reply.error { throw Refusal(error) }
    let status = reply.status ?? 0
    guard (200..<300).contains(status) else {
      // The route's own words are KOS's account, not always the owner's: kept in the log, said plainly.
      let words = reply.body.flatMap(Self.words) ?? "no words"
      Self.log.notice("\(request.path, privacy: .public) answered \(status): \(words, privacy: .public)")
      throw Refusal(status == 404 ? "That isn't there any more." : "KOS couldn't do that: \(words)")
    }
    return reply
  }

  private func decode<Value: Decodable>(_ type: Value.Type, _ body: JSONValue) throws -> Value {
    do {
      return try JSONDecoder().decode(type, from: body.json)
    } catch {
      Self.log.error("\(String(describing: type), privacy: .public) did not read: \(error.localizedDescription, privacy: .public)")
      throw Refusal("KOS sent this page in a shape this app does not read. Update the app or KOS.")
    }
  }

  /// A route's error body, `{ "error": "..." }`, as its words.
  private static func words(_ body: JSONValue) -> String? {
    guard case .object(let fields) = body, case .string(let words) = fields["error"] else { return nil }
    return words
  }
}
