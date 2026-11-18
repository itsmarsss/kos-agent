import CoreGraphics
import Foundation
import ImageIO

/// Each step's picture decoded once, by its frame id, downsampled to what a
/// chat draws: off the main actor, which also drives computer use, and never
/// again while the thread is redrawn as a turn goes. A frame id is one
/// picture for good on the KOS that kept it, so the KOS and the id key it.
public final class Thumbnails: @unchecked Sendable {
  public static let shared = Thumbnails()

  /// A picture: the KOS it came from (its pairing's device id, empty when there is only one) and its frame id there.
  public struct Key: Hashable, Sendable {
    public let source: String
    public let id: Int

    public init(source: String = "", id: Int) {
      self.source = source
      self.id = id
    }
  }

  /// The longest edge kept, in pixels: a picture opened full width in a chat window at 2x.
  public static let longestEdge = 900
  /// How many are kept: the window keeps no more pictures than this (ChatModel.picturesKept).
  public static let kept = 48

  private let lock = NSLock()
  private var images: [Key: CGImage] = [:]
  private var order: [Key] = []

  public init() {}

  /// The picture, when it has been decoded.
  public func cached(_ key: Key) -> CGImage? {
    lock.withLock { images[key] }
  }

  /// Nothing kept: another KOS's frame ids are not this one's.
  public func clear() {
    lock.withLock {
      images = [:]
      order = []
    }
  }

  /// The picture of `key`, decoded from `data` off the caller's actor the first time it is asked for.
  public func image(_ key: Key, from data: Data) async -> CGImage? {
    if let done = cached(key) { return done }
    let made = await Task.detached(priority: .userInitiated) { Self.decode(data) }.value
    guard let made else { return nil }
    return lock.withLock {
      if let raced = images[key] { return raced }
      images[key] = made
      order.append(key)
      while order.count > Self.kept { images[order.removeFirst()] = nil }
      return made
    }
  }

  /// A JPEG or PNG at most `longestEdge` on its longest side, drawn as the file says it is turned.
  static func decode(_ data: Data, longestEdge: Int = longestEdge) -> CGImage? {
    guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceShouldCacheImmediately: true,
      kCGImageSourceThumbnailMaxPixelSize: longestEdge,
    ]
    return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
  }
}
