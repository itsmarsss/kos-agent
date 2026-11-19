import CoreGraphics
import DeviceCore
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

/// KOS's eyes: one picture of the session's display.
///
/// This app's own windows (the border, KOS's cursor, the bar) are left out,
/// so KOS sees the screen and not itself, and so are the apps on the hidden
/// list: their windows are simply not in the picture. The fields KOS typed a
/// secret into, and a password field in focus, are painted black (`masks`,
/// in global points) before the picture is encoded, so no picture of them
/// ever leaves this Mac. They are read just before the picture and again
/// just after, and both are painted, so a field that moved meanwhile is
/// black where it was and where it went.
@MainActor
final class ScreenCapturer {
  struct Shot: Sendable {
    let jpeg: Data
    let width: Int
    let height: Int
  }

  static let quality = 0.8

  /// `region` is in global points; `pixels` is the size of the picture KOS gets.
  /// The displays and apps are listed afresh for every picture: a list kept
  /// even a moment could miss a hidden app whose window has just opened.
  func capture(display id: CGDirectDisplayID, region: CGRect?, pixels: Size, hiding hidden: [String], masks: () throws -> [CGRect]) async throws -> Shot {
    let content: SCShareableContent
    do {
      content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    } catch {
      throw DeviceError(.permission, "Screen Recording is not granted on this Mac.")
    }
    guard let display = content.displays.first(where: { $0.displayID == id }) else {
      throw DeviceError(.internal, "The session's display is gone.")
    }
    let hiddenSet = Set(hidden.map { $0.lowercased() })
    let me = getpid()
    let excluded = content.applications.filter { app in
      app.processID == me || hiddenSet.contains(app.bundleIdentifier.lowercased())
    }
    let filter = SCContentFilter(display: display, excludingApplications: excluded, exceptingWindows: [])
    let config = SCStreamConfiguration()
    config.width = Int(pixels.width)
    config.height = Int(pixels.height)
    config.showsCursor = true
    if let region {
      let frame = CGDisplayBounds(id)
      config.sourceRect = CGRect(x: region.minX - frame.minX, y: region.minY - frame.minY, width: region.width, height: region.height)
    }
    let before = try masks()
    let image: CGImage
    do {
      image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    } catch {
      throw DeviceError(.internal, "The screen could not be captured: \(error.localizedDescription)")
    }
    let masked = try Self.blackOut(image, Self.both(before, try masks()), source: region ?? CGDisplayBounds(id))
    return Shot(jpeg: try Self.jpeg(masked), width: masked.width, height: masked.height)
  }

  /// One window alone, whatever is in front of it; `region` is in global points.
  func capture(window id: CGWindowID, frame: CGRect, region: CGRect?, pixels: Size, masks: () throws -> [CGRect]) async throws -> Shot {
    let content: SCShareableContent
    do {
      content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
    } catch {
      throw DeviceError(.permission, "Screen Recording is not granted on this Mac.")
    }
    guard let window = content.windows.first(where: { $0.windowID == id }) else {
      throw DeviceError(.noSession, "The window KOS was given has closed.")
    }
    let config = SCStreamConfiguration()
    config.width = Int(pixels.width)
    config.height = Int(pixels.height)
    config.showsCursor = true
    if let region {
      config.sourceRect = CGRect(x: region.minX - frame.minX, y: region.minY - frame.minY, width: region.width, height: region.height)
    }
    let before = try masks()
    let image: CGImage
    do {
      image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: window), configuration: config)
    } catch {
      throw DeviceError(.internal, "The window could not be captured: \(error.localizedDescription)")
    }
    let masked = try Self.blackOut(image, Self.both(before, try masks()), source: region ?? frame)
    return Shot(jpeg: try Self.jpeg(masked), width: masked.width, height: masked.height)
  }

  /// The masks read before the picture and after it, each once.
  private static func both(_ before: [CGRect], _ after: [CGRect]) -> [CGRect] {
    before + after.filter { !before.contains($0) }
  }

  /// The picture with each mask (global points) painted black where it falls in `source`, the part of the screen
  /// the picture shows. Nothing to mask is the picture as it was.
  private static func blackOut(_ image: CGImage, _ masks: [CGRect], source: CGRect) throws -> CGImage {
    let rects = SecretMask.pixels(masks.map { Rect($0) }, source: Rect(source), picture: Size(width: Double(image.width), height: Double(image.height)))
    guard !rects.isEmpty else { return image }
    guard let context = CGContext(
      data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { throw DeviceError(.internal, "Could not mask the capture.") }
    let height = CGFloat(image.height)
    context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    context.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
    // The masks are top-left; the context's origin is bottom-left.
    for r in rects { context.fill(CGRect(x: r.x, y: height - r.y - r.height, width: r.width, height: r.height)) }
    guard let masked = context.makeImage() else { throw DeviceError(.internal, "Could not mask the capture.") }
    return masked
  }

  private static func jpeg(_ image: CGImage) throws -> Data {
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else {
      throw DeviceError(.internal, "Could not encode the capture.")
    }
    CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { throw DeviceError(.internal, "Could not encode the capture.") }
    return data as Data
  }
}
