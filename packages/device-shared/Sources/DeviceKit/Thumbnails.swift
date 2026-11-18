import CoreGraphics
import Foundation
import ImageIO

/// Each step's picture decoded once, by its frame id, downsampled to what a
/// chat draws: off the main actor, which also drives computer use, and never
/// again while the thread is redrawn as a turn goes. A frame id is one
/// picture for good, so the id alone keys it.
public final class Thumbnails: @unchecked Sendable {
  public static let shared = Thumbnails()

  /// The longest edge kept, in pixels: a picture opened full width in a chat window at 2x.
  public static let longestEdge = 900
  /// How many are kept: the window keeps no more pictures than this (ChatModel.picturesKept).
  public static let kept = 48

  private let lock = NSLock()
  private var images: [Int: CGImage] = [:]
  private var order: [Int] = []

  public init() {}

  /// The picture, when it has been decoded.
  public func cached(_ id: Int) -> CGImage? {
    lock.withLock { images[id] }
  }

  /// The picture of `id`, decoded from `data` off the caller's actor the first time it is asked for.
  public func image(_ id: Int, from data: Data) async -> CGImage? {
    if let done = cached(id) { return done }
    let made = await Task.detached(priority: .userInitiated) { Self.decode(data) }.value
    guard let made else { return nil }
    return lock.withLock {
      if let raced = images[id] { return raced }
      images[id] = made
      order.append(id)
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
