import DeviceKit
import PhoneCore
import PhotosUI
import SwiftUI

/// The files going with the next words, over the box: a picture as its
/// thumbnail, a file as its mark and name, each with a cross to leave it out.
struct AttachmentStrip: View {
  let files: [AttachmentTray.File]
  let remove: (String) -> Void

  var body: some View {
    ScrollView(.horizontal) {
      HStack(spacing: 10) {
        ForEach(files) { file in
          AttachmentChip(file: file) { remove(file.id) }
        }
      }
    }
    .scrollIndicators(.hidden)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Going with your words")
  }
}

/// One file going with the words: 56 points square, the row's height, on the box's own radius and hairline.
struct AttachmentChip: View {
  let file: AttachmentTray.File
  let remove: () -> Void

  static let side: CGFloat = 56
  /// The cross's drawn size, and how far in from the corner; it takes a thumb's 44 points.
  static let cross: CGFloat = 22
  static let inset: CGFloat = 4

  private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous) }

  var body: some View {
    face
      .frame(width: Self.side, height: Self.side)
      .clipShape(shape)
      .overlay(shape.strokeBorder(Theme.line))
      .overlay(alignment: .topTrailing) {
        Button(action: remove) {
          Image(systemName: "xmark")
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(Theme.text)
            .frame(width: Self.cross, height: Self.cross)
            .background(Theme.panel2, in: Circle())
            .overlay(Circle().strokeBorder(Theme.lineStrong))
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // Inside the corner, as the box's own crosses are: nothing of a chip reaches its neighbour.
        .offset(x: 22 - Self.cross / 2 - Self.inset, y: Self.cross / 2 + Self.inset - 22)
        .accessibilityLabel("Leave out \(file.name)")
      }
      .accessibilityElement(children: .contain)
      .accessibilityLabel(file.isPicture ? "Photo: \(file.name)" : "File: \(file.name)")
  }

  @ViewBuilder
  private var face: some View {
    if let thumbnail = file.thumbnail, let image = pictureImage(thumbnail) {
      image.resizable().aspectRatio(contentMode: .fill)
    } else {
      // A file by its mark and its kind, which a name cut to the chip's width would not say, clear of the cross.
      VStack(alignment: .leading, spacing: 2) {
        Image(systemName: "doc.text").font(.system(size: 15, weight: .medium))
        Text(Self.kind(file.name)).font(.kos(.tiny, .semibold)).lineLimit(1)
      }
      .foregroundStyle(Theme.muted)
      .padding(7)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
      .background(Theme.panel2)
    }
  }
}

extension AttachmentChip {
  /// A file's kind as its extension says it: PDF, DOCX, TXT.
  static func kind(_ name: String) -> String {
    let ext = (name as NSString).pathExtension.uppercased()
    return ext.isEmpty ? "FILE" : String(ext.prefix(5))
  }
}

/// A picture's bytes as an image, on either platform.
func pictureImage(_ data: Data) -> Image? {
  #if os(macOS)
    NSImage(data: data).map(Image.init(nsImage:))
  #else
    UIImage(data: data).map(Image.init(uiImage:))
  #endif
}

/// The system's pickers, opened from the attach menu: the photo library, and files. What the owner picks goes into
/// the tray, which brings a photo down and holds each to what KOS takes; the pickers themselves read nothing else.
struct Picking: ViewModifier {
  enum Source {
    case photos, files
  }

  @Binding var source: Source?
  @ObservedObject var tray: AttachmentTray
  @State private var photos: [PhotosPickerItem] = []

  func body(content: Content) -> some View {
    content
      .photosPicker(
        isPresented: Binding(get: { source == .photos }, set: { if !$0 { source = nil } }), selection: $photos,
        maxSelectionCount: max(1, AttachmentTray.most - tray.files.count), selectionBehavior: .ordered, matching: .images,
        preferredItemEncoding: .compatible)
      .fileImporter(
        isPresented: Binding(get: { source == .files }, set: { if !$0 { source = nil } }), allowedContentTypes: AttachmentTray.pickable,
        allowsMultipleSelection: true
      ) { result in
        guard case .success(let urls) = result else { return }
        for url in urls { take(url) }
      }
      .onChange(of: photos) { _, picked in
        guard !picked.isEmpty else { return }
        photos = []
        Task { @MainActor in
          for item in picked {
            if let data = try? await item.loadTransferable(type: Data.self) { tray.addPicture(data) }
          }
        }
      }
  }

  /// A file picked, read while the picker's grant holds; one far past what KOS takes, even as a photo brought down, is not read.
  private func take(_ url: URL) {
    let granted = url.startAccessingSecurityScopedResource()
    defer { if granted { url.stopAccessingSecurityScopedResource() } }
    let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
    guard size <= AttachmentTray.largest * 4, let data = try? Data(contentsOf: url, options: .mappedIfSafe) else {
      tray.note = "\(url.lastPathComponent) could not be read."
      return
    }
    tray.addFile(data, name: url.lastPathComponent)
  }
}
