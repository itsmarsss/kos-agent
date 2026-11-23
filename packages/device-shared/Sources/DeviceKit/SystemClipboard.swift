import DeviceCore
import Foundation

#if os(macOS)
  import AppKit
#else
  import UIKit
  import UniformTypeIdentifiers
#endif

/// The device's own clipboard, as DeviceCore's `ClipboardAccess` reads and writes it.
@MainActor
public final class SystemClipboard: ClipboardAccess {
  public init() {}

  #if os(macOS)
    private var board: NSPasteboard { .general }

    public var changeCount: Int { board.changeCount }

    public var itemTypes: [[String]] {
      (board.pasteboardItems ?? []).map { $0.types.map(\.rawValue) }
    }

    public func text() -> String? {
      board.string(forType: .string)
    }

    public func picture() -> Data? {
      if let png = board.data(forType: .png) { return png }
      guard let tiff = board.data(forType: .tiff) else { return nil }
      return NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:])
    }

    /// A sensitive copy carries the concealed and transient markers beside its text, each an empty value.
    public func write(_ text: String, sensitive: Bool) {
      board.clearContents()
      let item = NSPasteboardItem()
      item.setString(text, forType: .string)
      for marker in sensitive ? ClipboardMarker.sensitive : [] { item.setData(Data(), forType: NSPasteboard.PasteboardType(marker)) }
      board.writeObjects([item])
    }

    public func clear() {
      board.clearContents()
    }
  #else
    private var board: UIPasteboard { .general }

    public var changeCount: Int { board.changeCount }

    public var itemTypes: [[String]] { board.types.isEmpty ? [] : [board.types] }

    public func text() -> String? {
      board.string
    }

    public func picture() -> Data? {
      board.image?.pngData()
    }

    /// A sensitive copy stays on this phone (never Universal Clipboard) and lapses on its own after a minute,
    /// even while KOS for iPhone is suspended and cannot clear it.
    public func write(_ text: String, sensitive: Bool) {
      let item = [UTType.utf8PlainText.identifier: text]
      let options: [UIPasteboard.OptionsKey: Any] =
        sensitive ? [.localOnly: true, .expirationDate: Date().addingTimeInterval(ClipboardWriter.sensitiveFor)] : [:]
      board.setItems([item], options: options)
    }

    public func clear() {
      board.items = []
    }
  #endif
}

/// Every copy KOS for Mac and KOS for iPhone make goes through here: a sensitive one is marked and cleared after a
/// minute (ClipboardWriter).
@MainActor
public enum Clipboard {
  public static let writer = ClipboardWriter(SystemClipboard())

  public static func copy(_ text: String, sensitive: Bool = false) {
    writer.copy(text, sensitive: sensitive)
  }
}
