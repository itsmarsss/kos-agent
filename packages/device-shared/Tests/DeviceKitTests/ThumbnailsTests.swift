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
    #expect(thumbnails.cached(.init(id: 7)) == nil)
    let first = try #require(await thumbnails.image(.init(id: 7), from: data))
    #expect(max(first.width, first.height) == Thumbnails.longestEdge)
    #expect(first.width > first.height)
    // Asked again, by its id, it is the one already made, whatever is passed.
    let again = await thumbnails.image(.init(id: 7), from: Data())
    #expect(again === first)
    #expect(thumbnails.cached(.init(id: 7)) === first)
    // Bytes that are no picture make none.
    #expect(await thumbnails.image(.init(id: 8), from: Data("not a picture".utf8)) == nil)
  }

  @Test func keepsTheNewestAlone() async throws {
    let thumbnails = Thumbnails()
    let data = try png(width: 40, height: 30)
    for id in 0..<(Thumbnails.kept + 2) { _ = await thumbnails.image(.init(id: id), from: data) }
    #expect(thumbnails.cached(.init(id: 0)) == nil && thumbnails.cached(.init(id: 1)) == nil)
    #expect(thumbnails.cached(.init(id: Thumbnails.kept + 1)) != nil)
  }

  @Test func keepsEachKOSsPicturesApartAndForgetsThemOnAChange() async throws {
    let thumbnails = Thumbnails()
    let data = try png(width: 40, height: 30)
    _ = await thumbnails.image(.init(source: "home", id: 3), from: data)
    #expect(thumbnails.cached(.init(source: "home", id: 3)) != nil)
    #expect(thumbnails.cached(.init(source: "work", id: 3)) == nil)
    thumbnails.clear()
    #expect(thumbnails.cached(.init(source: "home", id: 3)) == nil)
  }

  /// A picture view handed another picture shows that one's, never the one it decoded before.
  @MainActor @Test func aPictureViewShowsOnlyItsOwnPicture() async throws {
    let thumbnails = Thumbnails()
    let data = try png(width: 40, height: 30)
    let first = ChatModel.Picture(id: 1, data: data, source: "home")
    let second = ChatModel.Picture(id: 2, data: data, source: "home")
    let made = try #require(await thumbnails.image(first.key, from: data))
    #expect(StepPicture.shown(first, made: (first.key, made), from: thumbnails) === made)
    #expect(StepPicture.shown(second, made: (first.key, made), from: thumbnails) == nil)
    // The same frame id from another KOS is another picture.
    #expect(ChatModel.Picture(id: 1, data: data, source: "work") != first)
  }
}
