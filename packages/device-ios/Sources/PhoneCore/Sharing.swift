import Foundation

/// What the owner shares from the phone goes to the system's share sheet as
/// a file: an artifact exported as KOS exports it for the dashboard, or a file
/// from the workspace. Never a link: nothing here is published anywhere.
public enum Sharing {
  /// The file, written under its own name in a folder of this app's that each share replaces, ready to hand over.
  public static func file(named name: String, _ data: Data) throws -> URL {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("share", isDirectory: true)
    try? FileManager.default.removeItem(at: folder)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let url = folder.appendingPathComponent(safe(name))
    try data.write(to: url, options: .atomic)
    return url
  }

  /// A name a file can have: no folder in it, no character a file system refuses, never empty.
  static func safe(_ name: String) -> String {
    let cleaned = name.map { "/\\:?*\"<>|\0".contains($0) ? "-" : $0 }
    let trimmed = String(cleaned).trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: ".")))
    return trimmed.isEmpty ? "KOS" : String(trimmed.prefix(120))
  }
}
