import DeviceCore
import Foundation

/// The dashboard's pages on the phone, each over the one line to KOS: the
/// Inbox, projects, artifacts, blobs, files, memory, runs and the overview.
/// What each read is kept while the app runs, so a tab shown again shows it
/// at once; pulling a page reads it again.
@MainActor
public final class Board {
  public let dashboard: Dashboard
  public let toasts: Toasts
  public let inbox: InboxModel
  public let projects: ProjectsModel
  public let gallery: GalleryModel
  public let blobs: BlobsModel
  public let files: FilesModel
  public let memory: MemoryModel
  public let runs: RunsModel
  public let overview: OverviewModel

  /// `sleep` is the clock its waits keep: on KOS's answers, and on each toast.
  public init(haptics: Haptics, sleep: @escaping @Sendable (Duration) async -> Void) {
    let dashboard = Dashboard(sleep: sleep)
    self.dashboard = dashboard
    let toasts = Toasts(sleep: sleep)
    self.toasts = toasts
    let say: (Toast) -> Void = { toasts.say($0) }
    inbox = InboxModel(dashboard: dashboard, haptics: haptics, say: say)
    projects = ProjectsModel(dashboard: dashboard)
    gallery = GalleryModel(dashboard: dashboard, haptics: haptics, say: say)
    blobs = BlobsModel(dashboard: dashboard)
    files = FilesModel(dashboard: dashboard)
    memory = MemoryModel(dashboard: dashboard)
    runs = RunsModel(dashboard: dashboard, haptics: haptics, say: say)
    overview = OverviewModel(dashboard: dashboard)
  }

  /// Another KOS, or none: nothing the last one said stays, and nothing asked of it is waited on.
  public func reset() {
    dashboard.reset()
    toasts.dismiss()
    inbox.reset()
    projects.reset()
    gallery.reset()
    blobs.reset()
    files.reset()
    memory.reset()
    runs.reset()
    overview.reset()
  }
}
