import DeviceCore
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// The files the owner has picked to go with their next words: pictures,
/// downscaled as they are picked, and files as they are. Each is held to
/// what KOS takes (docs/computer.md, Files with the words): four with one
/// message, five megabytes each, and only what it can read. Sent, they wait
/// aside until KOS has the words, and come back to the box if it never does.
@MainActor
public final class AttachmentTray: ObservableObject {
  public struct File: Equatable, Identifiable, Sendable {
    /// The id it goes to KOS under.
    public let id: String
    public let name: String
    public let mediaType: String
    public let bytes: Data
    /// A small JPEG of a picture, for the box; none for a file.
    public let thumbnail: Data?

    public init(id: String = "f\(UUID().uuidString.prefix(8).lowercased())", name: String, mediaType: String, bytes: Data, thumbnail: Data? = nil) {
      self.id = id
      self.name = name
      self.mediaType = mediaType
      self.bytes = bytes
      self.thumbnail = thumbnail
    }

    public var isPicture: Bool { mediaType.hasPrefix("image/") }

    /// The same file under a new id.
    var renewed: File { File(name: name, mediaType: mediaType, bytes: bytes, thumbnail: thumbnail) }
  }

  /// Files with one message, as KOS takes them.
  public static let most = 4
  /// Bytes in one file, as KOS takes them.
  public static let largest = 5 * 1024 * 1024
  /// The long side a photo is brought down to, and its JPEG quality.
  public static let pictureEdge = 2048
  static let pictureQuality = 0.8
  /// The long side of a picture's thumbnail in the box, in pixels: 56 points at three to a point.
  static let thumbnailEdge = 168

  @Published public private(set) var files: [File] = []
  /// Said once over the box: why a file was not taken.
  @Published public var note: String?
  /// Sent with words KOS has not taken yet.
  private var away: [File] = []

  public init() {}

  public var full: Bool { files.count >= Self.most }

  /// A photo the owner picked, as it came from the library: brought down to `pictureEdge` as a JPEG.
  public func addPicture(_ data: Data, name: String? = nil) {
    guard let picture = Picture(data) else { return refuse("That photo could not be read.") }
    let named = (name.map { ($0 as NSString).deletingPathExtension } ?? "Photo \(files.count + 1)") + ".jpg"
    guard let jpeg = picture.jpeg(edge: Self.pictureEdge, quality: Self.pictureQuality) else { return refuse("That photo could not be read.") }
    add(File(name: named, mediaType: "image/jpeg", bytes: jpeg, thumbnail: picture.jpeg(edge: Self.thumbnailEdge, quality: 0.7)))
  }

  /// A file the owner picked: a picture is brought down as a photo is; anything else goes as it is, if KOS reads it.
  public func addFile(_ data: Data, name: String) {
    let type = UTType(filenameExtension: (name as NSString).pathExtension)
    if type?.conforms(to: .image) == true { return addPicture(data, name: name) }
    guard let mediaType = Self.readable(type) else {
      return refuse("KOS cannot read \(name): send a picture, a PDF, an Office file or a text file.")
    }
    add(File(name: name, mediaType: mediaType, bytes: data))
  }

  public func remove(_ id: String) {
    files.removeAll { $0.id == id }
    note = nil
  }

  /// What goes with the words now: taken out of the box, and held aside until KOS has them.
  public func take() -> [File] {
    away = files
    files = []
    note = nil
    return away
  }

  /// KOS has the words: what went with them is done with.
  public func kept() {
    away = []
  }

  /// KOS never took the words: what went with them is back in the box, ahead of anything picked since, each under a
  /// new id, so sending them again is a new file to KOS rather than the end of one it half has.
  public func giveBack() {
    guard !away.isEmpty else { return }
    files = Array((away.map(\.renewed) + files).prefix(Self.most))
    away = []
  }

  public func reset() {
    files = []
    away = []
    note = nil
  }

  private func add(_ file: File) {
    guard !full else { return refuse("\(Self.most) files go with one message.") }
    // Measured as KOS measures it, from the base64's length (harness attachments.ts), so a file it takes here goes.
    guard (file.bytes.count + 2) / 3 * 3 <= Self.largest else {
      return refuse("\(file.name) is \(Self.megabytes(file.bytes.count)); KOS takes files up to \(Self.largest / 1024 / 1024) MB.")
    }
    note = nil
    files.append(file)
  }

  private func refuse(_ why: String) {
    note = why
  }

  private static func megabytes(_ bytes: Int) -> String {
    String(format: "%.1f MB", Double(bytes) / 1024 / 1024)
  }

  /// The media type KOS reads a file as, or nil for one it cannot: a PDF, an Office file, or text (harness attachments.ts).
  static func readable(_ type: UTType?) -> String? {
    guard let type else { return nil }
    if type.conforms(to: .pdf) { return "application/pdf" }
    let office = ["org.openxmlformats.wordprocessingml.document", "org.openxmlformats.spreadsheetml.sheet", "org.openxmlformats.presentationml.presentation"]
    if office.contains(type.identifier) { return type.preferredMIMEType }
    if type.conforms(to: .text) || type.conforms(to: .json) || type.conforms(to: .commaSeparatedText) || type.conforms(to: .sourceCode) {
      return type.preferredMIMEType ?? "text/plain"
    }
    return nil
  }

  /// The content types the file picker offers: what KOS reads.
  public static let pickable: [UTType] = [.image, .pdf, .text, .json, .commaSeparatedText, .sourceCode]
    + ["org.openxmlformats.wordprocessingml.document", "org.openxmlformats.spreadsheetml.sheet", "org.openxmlformats.presentationml.presentation"].compactMap { UTType($0) }
}

/// A picture read with ImageIO, which an iPhone and a Mac both have: brought down to a size, as a JPEG, upright.
struct Picture {
  private let source: CGImageSource

  init?(_ data: Data) {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(source) > 0 else { return nil }
    self.source = source
  }

  /// At most `edge` pixels on its long side, never larger than it is, turned the way it was taken.
  func jpeg(edge: Int, quality: Double) -> Data? {
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: edge,
    ]
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
    let out = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
    return CGImageDestinationFinalize(destination) ? out as Data : nil
  }
}
