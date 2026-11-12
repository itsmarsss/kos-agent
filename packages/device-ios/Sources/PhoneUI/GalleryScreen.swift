import DeviceCore
import DeviceKit
import PhoneCore
import SwiftUI

#if os(iOS)
  import UIKit
#endif

/// The Artifacts tab, as the dashboard's gallery: every artifact KOS made,
/// searched and held to a kind, under when each changed (today, this week,
/// earlier), opening to read at a tap; a long press shares one as its PDF,
/// Markdown, CSV or HTML. The trash is at the foot, each one restored with a
/// swipe or a press.
struct GalleryScreen: View {
  @ObservedObject var gallery: GalleryModel
  @ObservedObject private var all: Page<[Routes.Artifact]>
  @ObservedObject private var trash: Page<[Routes.Artifact]>
  @ObservedObject private var projects: Page<[Routes.Project]>
  let shelf: ArtifactShelf
  var now: Date = Date()
  @State private var sharing: Shared?
  @Environment(\.colorScheme) private var scheme

  init(gallery: GalleryModel, projects: Page<[Routes.Project]>, shelf: ArtifactShelf, now: Date = Date()) {
    self.gallery = gallery
    all = gallery.all
    trash = gallery.trash
    self.projects = projects
    self.shelf = shelf
    self.now = now
  }

  /// The artifacts by how long ago they changed, in the order given within each.
  static func groups(_ items: [Routes.Artifact], now: Date, calendar: Calendar = .current) -> [(title: String, items: [Routes.Artifact])] {
    let today = calendar.startOfDay(for: now)
    let week = calendar.date(byAdding: .day, value: -6, to: today) ?? today
    return [
      ("Today", items.filter { $0.updatedAt.at >= today }),
      ("This week", items.filter { $0.updatedAt.at < today && $0.updatedAt.at >= week }),
      ("Earlier", items.filter { $0.updatedAt.at < week }),
    ].filter { !$0.1.isEmpty }
  }

  var body: some View {
    PageFrame {
      PageHead(title: "Artifacts", detail: all.value.map { "\($0.count) to read" })
    } content: {
      Loaded(page: all, loading: "Reading your artifacts") { _ in
        PageList(refresh: gallery.refresh) {
          if let error = all.error { StaleNote(error: error).pageRow(separator: false) }
          VStack(spacing: 4) {
            SearchField(prompt: "Search artifacts", text: $gallery.words)
            FilterChips(options: [(nil, "All")] + GalleryModel.kinds.map { ($0, ArtifactKindMark.plural($0)) }, selected: gallery.kind) { gallery.kind = $0 }
              .padding(.horizontal, -16)
          }
          .padding(.top, 12)
          .pageRow(separator: false)
          let shown = gallery.shown
          if shown.isEmpty {
            PageNote(kind: .empty(
              symbol: "square.grid.2x2", title: gallery.words.isEmpty && gallery.kind == nil ? "No artifacts yet" : "Nothing matches",
              detail: gallery.words.isEmpty && gallery.kind == nil ? "Ask KOS for a doc, a sheet or a deck, and it shows here." : "Try other words, or another kind."))
              .pageRow(separator: false)
          }
          ForEach(Self.groups(shown, now: now), id: \.title) { group in
            GroupHead(title: group.title, count: group.items.count).pageRow(separator: false)
            ForEach(group.items) { item in
              ArtifactListRow(item: item, owner: owner(item), now: now) { shelf.open(item.id, title: item.title, dark: scheme == .dark) }
                .contextMenu { ShareMenu(item: item, gallery: gallery, sharing: $sharing) }
                .pageRow()
            }
          }
          if let trashed = trash.value, !trashed.isEmpty { trashRows(trashed) }
        }
      }
    }
    .task { await gallery.all.ensure() }
    .task { await gallery.trash.ensure() }
    .task { await projects.ensure() }
    .modifier(ShareSheet(shared: $sharing))
  }

  /// Whose it is, by the name the owner knows: a blob's, a project's, or KOS's own.
  private func owner(_ item: Routes.Artifact) -> String {
    if let blob = item.blob { return blob }
    guard let slug = item.projectSlug else { return "KOS" }
    return projects.value?.first { $0.slug == slug }?.name ?? slug
  }

  @ViewBuilder
  private func trashRows(_ items: [Routes.Artifact]) -> some View {
    GroupHead(title: "Trash", count: items.count).pageRow(separator: false)
    ForEach(items) { item in
      let busy = gallery.restoring.contains(item.id)
      HStack(spacing: 12) {
        PageRowLabel(symbol: ArtifactKindMark.symbol(item.artifactKind), tint: Theme.muted, title: item.title, detail: "In the trash · \(ChatTime.relative((item.trashedAt ?? item.updatedAt).at, now: now))")
        Button("Restore") { Task { await gallery.restore(item) } }
          .buttonStyle(KOSButtonStyle(.secondary, capsule: true))
          .frame(minHeight: 44)
          .disabled(busy)
          .accessibilityLabel("Restore \(item.title)")
      }
      .swipeActions(edge: .leading, allowsFullSwipe: true) {
        Button { Task { await gallery.restore(item) } } label: { Label("Restore", systemImage: "arrow.uturn.backward") }.tint(Theme.accent)
      }
      .pageRow()
    }
  }
}

/// One artifact in a list: its kind's mark, the title, then kind, owner (where the list is not already its owner's)
/// and age, and a line of what it is.
struct ArtifactListRow: View {
  let item: Routes.Artifact
  var owner: String? = nil
  let now: Date
  let open: () -> Void

  private var detail: String {
    [ArtifactKindMark.word(item.artifactKind), owner, ChatTime.relative(item.updatedAt.at, now: now)].compactMap { $0 }.joined(separator: " · ")
  }

  var body: some View {
    Button(action: open) {
      HStack(alignment: .top, spacing: 12) {
        Tile(ArtifactKindMark.symbol(item.artifactKind), tint: Theme.violet)
        VStack(alignment: .leading, spacing: 2) {
          Text(item.title).font(.kos(.body, .semibold)).foregroundStyle(Theme.text).lineLimit(1)
          Text(detail).font(.kos(.small)).foregroundStyle(Theme.muted).lineLimit(1)
          if let description = item.description, !description.isEmpty {
            Text(description).font(.kos(.small)).foregroundStyle(Theme.faint).lineLimit(1)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .padding(.vertical, 10)
      .frame(minHeight: 56)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityElement(children: .combine)
    .accessibilityHint("Opens it to read")
  }
}

/// An artifact's share menu: one item per way the dashboard exports its kind, each handing the file to the share sheet.
struct ShareMenu: View {
  let item: Routes.Artifact
  let gallery: GalleryModel
  @Binding var sharing: Shared?

  var body: some View {
    ForEach(GalleryModel.formats(item.artifactKind), id: \.self) { format in
      Button {
        Task {
          if let url = await gallery.export(id: item.id, title: item.title, format: format) { sharing = Shared(url: url) }
        }
      } label: {
        Label("Share as \(ArtifactKindMark.format(format))", systemImage: "square.and.arrow.up")
      }
    }
  }
}

/// A file on its way to the share sheet.
struct Shared: Identifiable {
  let url: URL
  var id: URL { url }
}

/// The system's share sheet for a file, on a phone; a Mac, where the app is only looked at, offers its own share button.
struct ShareSheet: ViewModifier {
  @Binding var shared: Shared?

  func body(content: Content) -> some View {
    content.sheet(item: $shared) { file in
      #if os(iOS)
        ActivityView(url: file.url).presentationDetents([.medium, .large]).ignoresSafeArea()
      #else
        ShareLink(item: file.url).padding(24)
      #endif
    }
  }
}

#if os(iOS)
  private struct ActivityView: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: [url], applicationActivities: nil) }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
  }
#endif
