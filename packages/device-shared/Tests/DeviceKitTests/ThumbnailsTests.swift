import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers

@testable import DeviceKit

/// A step's picture is decoded once, small enough to draw, by its frame id.
@Suite("Thumbnails")
struct ThumbnailsTests {
  /// A PNG of one colour, this size.
  private func png(width: Int, height: Int) throws -> Data {
    let context = try #require(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
    context.setFillColor(CGColor(red: 0.2, green: 0.5, blue: 0.9, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let image = try #require(context.makeImage())
    let data = NSMutableData()
    let dest = try #require(CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil))
    CGImageDestinationAddImage(dest, image, nil)
    #expect(CGImageDestinationFinalize(dest))
    return data as Data
  }

  @Test func decodesOnceDownsampledAndKeepsItByItsFrameId() async throws {
    let thumbnails = Thumbnails()
    let data = try png(width: 2464, height: 1600)
    #expect(thumbnails.cached(7) == nil)
    let first = try #require(await thumbnails.image(7, from: data))
    #expect(max(first.width, first.height) == Thumbnails.longestEdge)
    #expect(first.width > first.height)
    // Asked again, by its id, it is the one already made, whatever is passed.
    let again = await thumbnails.image(7, from: Data())
    #expect(again === first)
    #expect(thumbnails.cached(7) === first)
    // Bytes that are no picture make none.
    #expect(await thumbnails.image(8, from: Data("not a picture".utf8)) == nil)
  }

  @Test func keepsTheNewestAlone() async throws {
    let thumbnails = Thumbnails()
    let data = try png(width: 40, height: 30)
    for id in 0..<(Thumbnails.kept + 2) { _ = await thumbnails.image(id, from: data) }
    #expect(thumbnails.cached(0) == nil && thumbnails.cached(1) == nil)
    #expect(thumbnails.cached(Thumbnails.kept + 1) != nil)
  }
}
