import CoreGraphics
import DeviceCore
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

/// KOS's eyes: one picture of the session's display.
///
/// This app's own windows (the border, KOS's cursor, the bar) are left out,
/// so KOS sees the screen and not itself, and so are the apps on the hidden
/// list: their windows are simply not in the picture.
@MainActor
final class ScreenCapturer {
  struct Shot {
    let jpeg: Data
    let width: Int
    let height: Int
  }

  static let quality = 0.8

  /// `region` is in global points; `pixels` is the size of the picture KOS gets.
  func capture(display id: CGDirectDisplayID, region: CGRect?, pixels: Size, hiding hidden: [String]) async throws -> Shot {
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
    let image: CGImage
    do {
      image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    } catch {
      throw DeviceError(.internal, "The screen could not be captured: \(error.localizedDescription)")
    }
    return Shot(jpeg: try Self.jpeg(image), width: image.width, height: image.height)
  }

  /// One window alone, whatever is in front of it; `region` is in global points.
  func capture(window id: CGWindowID, frame: CGRect, region: CGRect?, pixels: Size) async throws -> Shot {
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
    let image: CGImage
    do {
      image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: window), configuration: config)
    } catch {
      throw DeviceError(.internal, "The window could not be captured: \(error.localizedDescription)")
    }
    return Shot(jpeg: try Self.jpeg(image), width: image.width, height: image.height)
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
