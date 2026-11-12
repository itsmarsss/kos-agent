import DeviceCore
import DeviceKit
import PDFKit
import PhoneCore
import SwiftUI

/// Files: the workspace a folder at a time, read only, as the dashboard's
/// Files page browses it. A folder opens the next; a file opens as what it
/// is, full screen: its words, a picture to pinch, or a PDF as the system
/// draws one, with the share sheet at the head.
struct FolderScreen: View {
  let path: String
  @ObservedObject var page: Page<Routes.Folder>
  var now: Date = Date()
  @Environment(\.go) private var go
  @Environment(\.dismiss) private var dismiss

  private var title: String { path == "." ? "Files" : (path as NSString).lastPathComponent }

  var body: some View {
    PageFrame {
      PageHead(title: title, detail: path == "." ? "Your workspace" : path, back: { dismiss() })
    } content: {
      Loaded(page: page, loading: "Reading the folder") { folder in
        PageList(refresh: page.refresh) {
          if let error = page.error { StaleNote(error: error).pageRow(separator: false) }
          if folder.entries.isEmpty {
            PageNote(kind: .empty(symbol: "folder", title: "This folder is empty", detail: "What KOS writes here shows up as it does.")).pageRow(separator: false)
          }
          ForEach(folder.entries) { entry in
            Button { go(entry.folder ? .folder(path: entry.path) : .file(path: entry.path, name: entry.name)) } label: {
              PageRowLabel(
                symbol: FileMark.symbol(entry), tint: entry.folder ? Theme.accent : Theme.muted, title: entry.name,
                detail: entry.folder ? ChatTime.relative(entry.modifiedAt.at, now: now) : "\(FilesModel.size(entry.size)) · \(ChatTime.relative(entry.modifiedAt.at, now: now))",
                opens: true)
            }
            .buttonStyle(.plain)
            .pageRow()
          }
        }
      }
    }
    .task { await page.ensure() }
  }
}

/// How a file is marked, by what it opens as.
enum FileMark {
  static func symbol(_ entry: Routes.Entry) -> String {
    if entry.folder { return "folder.fill" }
    switch FilesModel.way(entry.path) {
    case .picture: return "photo"
    case .pdf: return "doc.richtext"
    case .text: return "doc.text"
    }
  }
}

/// One file, full screen: its words, its picture or its PDF, and Share.
struct FileScreen: View {
  let name: String
  @ObservedObject var page: Page<FilesModel.Opened>
  @State private var sharing: Shared?
  @Environment(\.dismiss) private var dismiss

  private var detail: String? {
    switch page.value {
    case .text(let file): return [FilesModel.size(file.size), file.extracted.map { "read from \($0)" }].compactMap { $0 }.joined(separator: " · ")
    case .picture(let data, _), .pdf(let data): return FilesModel.size(Double(data.count))
    default: return nil
    }
  }

  var body: some View {
    PageFrame {
      PageHead(title: name, detail: detail, back: { dismiss() }) {
        if let opened = page.value, let file = FilesModel.shared(opened, name: name) {
          HeaderButton(symbol: "square.and.arrow.up", label: "Share \(name)") {
            if let url = try? Sharing.file(named: file.name, file.data) { sharing = Shared(url: url) }
          }
        }
      }
    } content: {
      Loaded(page: page, loading: "Opening \(name)") { opened in
        switch opened {
        case .text(let file):
          ScrollView {
            Text(file.text ?? "")
              .font(.kos(.small, design: file.extracted == nil ? .monospaced : .default))
              .foregroundStyle(Theme.text)
              .textSelection(.enabled)
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(16)
          }
        case .picture(let data, _):
          Picture(data: data)
        case .pdf(let data):
          PDFPages(data: data)
        case .none(let why):
          PageNote(kind: .empty(symbol: "doc", title: "Nothing to show", detail: why)).frame(maxHeight: .infinity)
        }
      }
    }
    .task { await page.ensure() }
    .modifier(ShareSheet(shared: $sharing))
  }
}

/// A picture from the workspace, fit to the screen and pinched to look closer.
private struct Picture: View {
  let data: Data
  @State private var zoom: CGFloat = 1
  @GestureState private var pinch: CGFloat = 1

  var body: some View {
    Group {
      if let image = image {
        image.resizable().scaledToFit()
          .scaleEffect(zoom * pinch)
          .gesture(MagnifyGesture().updating($pinch) { value, state, _ in state = value.magnification }.onEnded { zoom = min(max(zoom * $0.magnification, 1), 6) })
          .onTapGesture(count: 2) { zoom = zoom > 1 ? 1 : 2.5 }
          .accessibilityLabel("The picture")
      } else {
        PageNote(kind: .empty(symbol: "photo", title: "Can't draw this picture", detail: "Its format isn't one this phone draws."))
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .padding(16)
  }

  private var image: Image? {
    #if os(iOS)
      UIImage(data: data).map { Image(uiImage: $0) }
    #else
      NSImage(data: data).map { Image(nsImage: $0) }
    #endif
  }
}

/// A PDF as the system draws one: its pages in a column, to scroll and pinch.
private struct PDFPages {
  let data: Data

  func view() -> PDFView {
    let view = PDFView()
    view.document = PDFDocument(data: data)
    view.autoScales = true
    view.displayMode = .singlePageContinuous
    view.displayDirection = .vertical
    view.backgroundColor = .clear
    return view
  }
}

#if os(iOS)
  extension PDFPages: UIViewRepresentable {
    func makeUIView(context: Context) -> PDFView { view() }
    func updateUIView(_ view: PDFView, context: Context) {}
  }
#else
  extension PDFPages: NSViewRepresentable {
    func makeNSView(context: Context) -> PDFView { view() }
    func updateNSView(_ view: PDFView, context: Context) {}
  }
#endif
