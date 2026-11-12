import DeviceCore

/// What the window says of KOS's word on this app's build: an update under
/// way, or one that waits on the owner (signing to set up, a build that did
/// not take). Nothing for an app that is current, one KOS updates by itself
/// when it is idle, or one KOS cannot reach to rebuild.
public struct UpdateWords: Equatable {
  public let title: String
  public let detail: String
  public let symbol: String
  /// Under way: nothing to do or put away.
  public let working: Bool

  public init?(_ notice: UpdateNotice) {
    switch (notice.state, notice.reason) {
    case (.updating, _):
      self.init("Updating KOS for Mac", "KOS is rebuilding this app from its checkout. It quits and opens again by itself.", "arrow.triangle.2.circlepath", working: true)
    case (.behind, .signing):
      self.init(
        "An update is ready",
        "KOS rebuilds this app by itself once your signing key is set up; until then each build asks for Screen Recording and Accessibility again. Set it up once in Terminal, or press Update now in KOS's Settings, Devices.",
        "arrow.down.circle", working: false)
    case (.behind, .failed):
      // KOS's reason is a clause; said here as a sentence of its own.
      let why = notice.detail.map { "\($0.prefix(1).uppercased())\($0.dropFirst()). " } ?? ""
      self.init("The update did not finish", "\(why)Run it yourself:", "exclamationmark.triangle", working: false)
    case (.behind, .stuck):
      self.init("Still on the old build", "KOS rebuilt this app and it came back unchanged. Run the update in Terminal to see why.", "exclamationmark.triangle", working: false)
    default:
      return nil
    }
  }

  private init(_ title: String, _ detail: String, _ symbol: String, working: Bool) {
    self.title = title
    self.detail = detail
    self.symbol = symbol
    self.working = working
  }
}
