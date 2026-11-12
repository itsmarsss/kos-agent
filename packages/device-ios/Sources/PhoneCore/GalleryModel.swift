import DeviceCore
import Foundation

/// Every artifact, as the dashboard's gallery lists them: the latest changed
/// first, held to a kind or some words, with the trash under them, where one
/// can be restored. Only HTML artifacts open on a phone; an older widget page
/// is left to the dashboard.
@MainActor
public final class GalleryModel: ObservableObject {
  public let all: Page<[Routes.Artifact]>
  public let trash: Page<[Routes.Artifact]>
  /// The kind the gallery is held to; every kind with none.
  @Published public var kind: String?
  @Published public var words = ""
  @Published public private(set) var restoring: Set<String> = []

  /// The kinds, in the dashboard's order.
  public static let kinds = ["doc", "sheet", "deck", "page"]

  /// What each kind is taken away as, as the dashboard's menus offer it (artifactexport.ts, KIND_EXPORTS).
  public static func formats(_ kind: String) -> [String] {
    switch kind {
    case "doc": ["pdf", "md", "html"]
    case "sheet": ["csv", "html"]
    default: ["pdf", "html"]
    }
  }

  private let dashboard: Dashboard
  private let haptics: Haptics
  private let say: (Toast) -> Void

  public init(dashboard: Dashboard, haptics: Haptics, say: @escaping (Toast) -> Void) {
    self.dashboard = dashboard
    self.haptics = haptics
    self.say = say
    all = Page { try await Self.read(dashboard, trashed: false) }
    trash = Page { try await Self.read(dashboard, trashed: true) }
  }

  private static func read(_ dashboard: Dashboard, trashed: Bool) async throws -> [Routes.Artifact] {
    try await dashboard.get(Routes.List<Routes.Artifact>.self, "/api/artifacts", query: trashed ? ["trashed": "1"] : [:]).items
      .filter(\.opens)
      .sorted { (trashed ? $0.trashedAt ?? 0 : $0.updatedAt) > (trashed ? $1.trashedAt ?? 0 : $1.updatedAt) }
  }

  /// What the gallery shows, held to the kind and words: a title or description holding every word.
  public var shown: [Routes.Artifact] {
    Self.held(all.value ?? [], kind: kind, words: words)
  }

  static func held(_ items: [Routes.Artifact], kind: String?, words: String) -> [Routes.Artifact] {
    let terms = words.lowercased().split(whereSeparator: \.isWhitespace)
    return items.filter { item in
      guard kind == nil || item.artifactKind == kind else { return false }
      let text = "\(item.title) \(item.description ?? "")".lowercased()
      return terms.allSatisfy { text.contains($0) }
    }
  }

  public func refresh() async {
    async let living: Void = all.refresh()
    async let trashed: Void = trash.refresh()
    _ = await (living, trashed)
  }

  /// Out of the trash, as the dashboard's Restore does.
  public func restore(_ item: Routes.Artifact) async {
    guard !restoring.contains(item.id) else { return }
    restoring.insert(item.id)
    defer { restoring.remove(item.id) }
    do {
      try await dashboard.post("/api/artifacts/\(item.id)/restore")
      haptics.done()
      say(.init("Restored \(item.title)"))
      await refresh()
    } catch {
      haptics.attention()
      say(.init("Couldn't restore \(item.title). \((error as? Dashboard.Refusal)?.message ?? "")", tone: .warn))
    }
  }

  /// One exported as KOS exports it for the dashboard, as a file to share; said when it could not be.
  public func export(id: String, title: String, format: String) async -> URL? {
    do {
      let file = try await dashboard.bytes("/api/artifacts/\(id)/export", query: ["format": format])
      return try Sharing.file(named: "\(title).\(format == "csv" && file.type.contains("zip") ? "zip" : format)", file.data)
    } catch {
      haptics.attention()
      say(.init("Couldn't export \(title). \((error as? Dashboard.Refusal)?.message ?? "")", tone: .warn))
      return nil
    }
  }

  public func reset() {
    all.reset()
    trash.reset()
    kind = nil
    words = ""
    restoring = []
  }
}
