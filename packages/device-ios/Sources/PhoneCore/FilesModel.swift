import DeviceCore
import Foundation

/// The workspace's files, as the dashboard's Files page browses them: a
/// folder at a time, read only, every path through KOS's jail. A file opens
/// as what it is: a picture or a PDF as its bytes, drawn natively; anything
/// else as its words, or the words KOS reads out of a document.
@MainActor
public final class FilesModel: ObservableObject {
  /// A file opened, as the phone draws it.
  public enum Opened: Equatable, Sendable {
    case text(Routes.File)
    case picture(Data, type: String)
    case pdf(Data)
    /// Nothing to show here, and why, in the owner's words.
    case none(String)
  }

  private let dashboard: Dashboard
  private var folders: [String: Page<Routes.Folder>] = [:]
  private var files: [String: Page<Opened>] = [:]

  /// What the jail draws as a picture (files.ts, IMAGE_TYPES).
  nonisolated static let pictures: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"]

  public init(dashboard: Dashboard) {
    self.dashboard = dashboard
  }

  /// A folder's entries, folders first, then by name as the dashboard sorts them; "." is the workspace's top.
  public func folder(_ path: String) -> Page<Routes.Folder> {
    if let page = folders[path] { return page }
    let dashboard = dashboard
    let page = Page {
      let folder = try await dashboard.get(Routes.Folder.self, "/api/files", query: ["path": path])
      return Routes.Folder(path: folder.path, entries: Self.sorted(folder.entries))
    }
    folders[path] = page
    return page
  }

  static func sorted(_ entries: [Routes.Entry]) -> [Routes.Entry] {
    entries.sorted { ($0.folder ? 0 : 1, $0.name.lowercased()) < ($1.folder ? 0 : 1, $1.name.lowercased()) }
  }

  /// How a file opens, by its name.
  nonisolated public static func way(_ path: String) -> Way {
    let ext = (path as NSString).pathExtension.lowercased()
    if pictures.contains(ext) { return .picture }
    return ext == "pdf" ? .pdf : .text
  }

  public enum Way: Sendable { case text, picture, pdf }

  /// One file, opened as what it is.
  public func file(_ path: String) -> Page<Opened> {
    if let page = files[path] { return page }
    let dashboard = dashboard
    let page = Page<Opened> {
      switch Self.way(path) {
      case .picture:
        let got = try await dashboard.bytes("/api/file/raw", query: ["path": path])
        return .picture(got.data, type: got.type)
      case .pdf:
        return .pdf(try await dashboard.bytes("/api/file/view", query: ["path": path]).data)
      case .text:
        let file = try await dashboard.get(Routes.File.self, "/api/file", query: ["path": path])
        if file.text != nil { return .text(file) }
        return .none(file.omitted == "too-large" ? "This file is too big to read here." : "This file isn't something a phone can show.")
      }
    }
    files[path] = page
    return page
  }

  /// A file's size as people read one (schedulewords.ts, sizeWords).
  nonisolated public static func size(_ bytes: Double) -> String {
    if bytes < 1024 { return "\(Int(bytes)) B" }
    if bytes < 1024 * 1024 { return String(format: bytes < 10 * 1024 ? "%.1f KB" : "%.0f KB", bytes / 1024) }
    return String(format: "%.1f MB", bytes / (1024 * 1024))
  }

  /// What goes to the share sheet for a file opened: its bytes, or its words, named for what they are.
  nonisolated public static func shared(_ opened: Opened, name: String) -> (name: String, data: Data)? {
    switch opened {
    case .picture(let data, _), .pdf(let data): return (name, data)
    case .text(let file): return (file.extracted == nil ? name : "\(name).txt", Data((file.text ?? "").utf8))
    case .none: return nil
    }
  }

  public func reset() {
    folders = [:]
    files = [:]
  }
}
