import DeviceCore
import DeviceKit
import PhoneCore
import SwiftUI

/// Blobs: KOS's standing helpers, each with what it is for and what it is up
/// to, opening its page.
struct BlobsScreen: View {
  @ObservedObject var blobs: BlobsModel
  @ObservedObject private var list: Page<[Routes.Blob]>
  var now: Date = Date()
  @Environment(\.go) private var go
  @Environment(\.dismiss) private var dismiss

  init(blobs: BlobsModel, now: Date = Date()) {
    self.blobs = blobs
    list = blobs.list
    self.now = now
  }

  var body: some View {
    PageFrame {
      PageHead(title: "Blobs", detail: list.value.map { $0.count == 1 ? "1 helper" : "\($0.count) helpers" }, back: { dismiss() })
    } content: {
      Loaded(page: list, loading: "Reading your blobs") { all in
        PageList(refresh: list.refresh) {
          if let error = list.error { StaleNote(error: error).pageRow(separator: false) }
          if all.isEmpty {
            PageNote(kind: .empty(symbol: "circle.hexagongrid", title: "No blobs yet", detail: "Ask KOS to keep something up for you, and it makes one."))
              .pageRow(separator: false)
          }
          ForEach(all) { blob in
            Button { go(.blob(blob.name)) } label: { BlobRow(blob: blob, now: now) }.buttonStyle(.plain).pageRow()
          }
        }
        .padding(.top, 1)
      }
    }
    .task { await list.ensure() }
  }
}

/// What a blob is up to, in a word, and its tone.
enum BlobState {
  static func of(_ blob: Routes.Blob) -> (words: String, tint: Color) {
    switch blob.thread?.activity {
    case "working": return ("Working", Theme.accent)
    case "needs-you": return ("Waiting on you", Theme.warn)
    case "error": return ("Its last turn failed", Theme.danger)
    default:
      guard let job = blob.job else { return ("On request", Theme.muted) }
      return job.enabled ? ("Scheduled", Theme.violet) : ("Paused", Theme.muted)
    }
  }
}

/// One blob: its name and what it is for, and its state.
struct BlobRow: View {
  let blob: Routes.Blob
  let now: Date

  var body: some View {
    let state = BlobState.of(blob)
    HStack(alignment: .top, spacing: 12) {
      Tile("circle.hexagongrid.fill", tint: state.tint)
      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 6) {
          Text(blob.name).font(.kos(.body, .semibold)).foregroundStyle(Theme.text).lineLimit(1)
          if blob.thread?.unread == true { Dot(Theme.accent, size: 7).accessibilityLabel("Unread") }
        }
        Text(blob.description).font(.kos(.small)).foregroundStyle(Theme.muted).lineLimit(1)
        Text([state.words, blob.thread.map { ChatTime.relative($0.updatedAt.at, now: now) }].compactMap { $0 }.joined(separator: " · "))
          .font(.kos(.tiny, .medium)).foregroundStyle(state.tint).lineLimit(1)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      Image(systemName: "chevron.right").font(.kos(.detail, .semibold)).foregroundStyle(Theme.faint).padding(.top, 4)
    }
    .padding(.vertical, 10)
    .frame(minHeight: 56)
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
  }
}

/// One blob's page: what it is for, its schedule to run now or pause, its chat read, and what it made.
struct BlobScreen: View {
  let name: String
  @ObservedObject var blobs: BlobsModel
  @ObservedObject private var list: Page<[Routes.Blob]>
  @ObservedObject private var made: Page<[Routes.Artifact]>
  @ObservedObject var runs: RunsModel
  let shelf: ArtifactShelf
  var now: Date = Date()
  @Environment(\.go) private var go
  @Environment(\.dismiss) private var dismiss
  @Environment(\.colorScheme) private var scheme

  init(name: String, blobs: BlobsModel, gallery: GalleryModel, runs: RunsModel, shelf: ArtifactShelf, now: Date = Date()) {
    self.name = name
    self.blobs = blobs
    list = blobs.list
    made = gallery.all
    self.runs = runs
    self.shelf = shelf
    self.now = now
  }

  var body: some View {
    let blob = list.value?.first { $0.name == name }
    PageFrame {
      PageHead(title: name, detail: blob.map { BlobState.of($0).words }, back: { dismiss() })
    } content: {
      if let blob {
        PageList(refresh: refresh) {
          Text(blob.description).font(.kos(.body)).foregroundStyle(Theme.text).fixedSize(horizontal: false, vertical: true)
            .padding(.vertical, 14)
          .pageRow(separator: false)
          if let job = blob.job {
            GroupHead(title: "Schedule").pageRow(separator: false)
            CronRow(job: job.cron(named: blob.name), runs: runs, now: now).pageRow()
          }
          GroupHead(title: "Its chat").pageRow(separator: false)
          Button { go(.chat(id: blob.conversationId, title: blob.name)) } label: {
            PageRowLabel(
              symbol: "bubble.left.and.bubble.right", tint: Theme.accent, title: blob.thread?.lastSaid ?? "Nothing said yet",
              detail: blob.thread.map { "Last \(ChatTime.relative($0.updatedAt.at, now: now))" }, opens: true)
          }
          .buttonStyle(.plain)
          .pageRow()
          let items = (made.value ?? []).filter { $0.blob == blob.name }
          GroupHead(title: "What it made", count: items.count).pageRow(separator: false)
          if items.isEmpty {
            Text("Nothing yet.").font(.kos(.dense)).foregroundStyle(Theme.muted).padding(.bottom, 8).pageRow(separator: false)
          }
          ForEach(items) { item in
            ArtifactListRow(item: item, now: now) { shelf.open(item.id, title: item.title, dark: scheme == .dark) }.pageRow()
          }
        }
      } else {
        Loaded(page: list, loading: "Reading \(name)") { _ in
          PageNote(kind: .empty(symbol: "circle.hexagongrid", title: "\(name) isn't here", detail: "It may have been removed. Pull to read the blobs again."))
        }
      }
    }
    .task {
      await list.ensure()
      await made.ensure()
    }
  }

  private func refresh() async {
    async let blobs: Void = list.refresh()
    async let artifacts: Void = made.refresh()
    _ = await (blobs, artifacts)
  }
}

/// A chat's words, read: the owner's in bubbles and KOS's as the chat draws them, newest at the foot. Nothing is
/// said here; it is written to in its own place.
struct ChatReadScreen: View {
  let title: String
  @ObservedObject var page: Page<Routes.Transcript>
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    PageFrame {
      PageHead(title: title, detail: "Read only", back: { dismiss() })
    } content: {
      Loaded(page: page, loading: "Reading the chat") { transcript in
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 14) {
            if transcript.messages.isEmpty {
              PageNote(kind: .empty(symbol: "bubble.left", title: "Nothing said yet", detail: "Its words show here once it has some."))
            }
            ForEach(Array(transcript.messages.enumerated()), id: \.offset) { _, message in
              if message.role == "you" {
                Bubble(text: message.text, files: [])
              } else {
                ChatMarkdown(message.text).frame(maxWidth: .infinity, alignment: .leading)
              }
            }
          }
          .font(.kos(.body))
          .padding(.horizontal, 16)
          .padding(.vertical, 16)
        }
        .defaultScrollAnchor(.bottom)
        .refreshable { await page.refresh() }
      }
    }
    .task { await page.ensure() }
  }
}
