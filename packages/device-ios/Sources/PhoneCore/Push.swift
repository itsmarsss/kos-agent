import DeviceCore
import Foundation

#if os(iOS)
  import UIKit
  import UserNotifications
#endif

/// Whether the owner lets KOS's asks onto this phone's lock screen.
public enum PushPermission: Sendable, Equatable {
  case undecided, allowed, denied
}

/// What only an iPhone does with notifications: ask the owner's leave, register with APNs, take a notification
/// down, and post one of its own. A build with no push (no `aps-environment`, README, Push) has no environment.
@MainActor
public protocol Notifier: AnyObject {
  var environment: PushEnvironment? { get }
  func permission() async -> PushPermission
  func requestPermission() async -> PushPermission
  /// Asks APNs for this phone's token; it comes back to the app's delegate.
  func register()
  func withdraw(_ identifiers: [String])
  func withdrawAll()
  /// A decision from a notification that did not reach KOS: in its place, one that opens the ask.
  func couldNotDecide(ask: String)
}

/// Notifications where there are none: on a Mac, where the app runs only to be looked at, and in a build with no push.
public final class NoNotifier: Notifier {
  public nonisolated init() {}
  public var environment: PushEnvironment? { nil }
  public func permission() async -> PushPermission { .denied }
  public func requestPermission() async -> PushPermission { .denied }
  public func register() {}
  public func withdraw(_ identifiers: [String]) {}
  public func withdrawAll() {}
  public func couldNotDecide(ask: String) {}
}

/// KOS's asks on the lock screen: the owner's leave, asked once right after pairing or from Settings and never
/// at launch; the token APNs gives this phone, told to KOS each time it is on the line; and a notification taken
/// down once its ask is settled.
@MainActor
public final class PushModel: ObservableObject {
  /// What the owner allows, once read; nil before it is, and always in a build with no push.
  @Published public private(set) var permission: PushPermission?
  /// The token APNs gave this phone, as hex; asked for again at each launch, as Apple has it.
  @Published public private(set) var token: String?
  /// Why APNs gave no token, in its words.
  @Published public private(set) var problem: String?

  /// KOS is told of a token, or that there is none; the phone sends it while KOS is on the line.
  var tell: (PushToken) -> Void = { _ in }

  private let notifier: Notifier

  public init(notifier: Notifier) {
    self.notifier = notifier
  }

  /// Whether this build can have push at all: signed with an `aps-environment`.
  public var available: Bool { notifier.environment != nil }

  /// The owner's asks reach this phone: allowed, and APNs gave a token.
  public var on: Bool { permission == .allowed && token != nil }

  /// What the owner allows now, read asking nothing: at launch and on coming back, since it may have been changed
  /// in the iPhone's Settings. Allowed, the token is asked for; taken back, KOS is told to forget it.
  public func refresh() async {
    guard available else { return }
    let now = await notifier.permission()
    permission = now
    if now == .allowed {
      notifier.register()
    } else if token != nil {
      token = nil
      tell(.off)
    }
  }

  /// The owner's leave, asked for: from Settings, or by `offer` once the phone is paired.
  public func turnOn() async {
    guard available else { return }
    permission = await notifier.requestPermission()
    if permission == .allowed { notifier.register() }
  }

  /// Just paired: asked once, and only while the owner has said neither yes nor no.
  public func offer() async {
    guard available, await notifier.permission() == .undecided else { return }
    await turnOn()
  }

  /// APNs gave this phone its token: KOS is told.
  public func registered(_ deviceToken: Data) {
    guard let env = notifier.environment else { return }
    let hex = PushToken.hex(deviceToken)
    token = hex
    problem = nil
    tell(PushToken(token: hex, env: env))
  }

  public func failed(_ message: String) {
    problem = message
  }

  /// What KOS is told each time the phone is on the line: the token while asks may come here, that there is none
  /// once the owner said no, and nothing before either is known.
  var current: PushToken? {
    guard let env = notifier.environment, let permission else { return nil }
    if permission == .allowed, let token { return PushToken(token: token, env: env) }
    return permission == .denied ? .off : nil
  }

  /// The ask is settled: its notification goes.
  func withdraw(ask id: String) {
    notifier.withdraw([PushNote.identifier(ask: id)])
  }

  /// Another KOS, or none: nothing the last one pushed stays on the phone.
  func reset() {
    notifier.withdrawAll()
  }

  func couldNotDecide(ask id: String) {
    notifier.couldNotDecide(ask: id)
  }
}

#if os(iOS)
  /// The iPhone's own: UserNotifications and APNs. Its environment is the build's `aps-environment`, written into
  /// Info.plist as `KOSAPSEnvironment` by the `KOS_APS_ENVIRONMENT` build setting (README, Push); unset, it has none.
  public final class SystemNotifier: Notifier {
    private let center = UNUserNotificationCenter.current()

    public init() {}

    public var environment: PushEnvironment? {
      PushEnvironment(apsEnvironment: Bundle.main.object(forInfoDictionaryKey: "KOSAPSEnvironment") as? String)
    }

    /// The ask's actions: Approve only with the phone unlocked, Deny from the lock screen as it is. An ask too long
    /// to approve unseen offers Deny alone, as the app's card does.
    public static var categories: Set<UNNotificationCategory> {
      let approve = UNNotificationAction(identifier: PushNote.approveAction, title: "Approve", options: [.authenticationRequired])
      let deny = UNNotificationAction(identifier: PushNote.denyAction, title: "Deny", options: [.destructive])
      return [
        UNNotificationCategory(identifier: PushNote.askCategory, actions: [approve, deny], intentIdentifiers: []),
        UNNotificationCategory(identifier: PushNote.openCategory, actions: [deny], intentIdentifiers: []),
      ]
    }

    public func permission() async -> PushPermission {
      Self.permission(await center.notificationSettings().authorizationStatus)
    }

    public func requestPermission() async -> PushPermission {
      _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
      return await permission()
    }

    public func register() {
      UIApplication.shared.registerForRemoteNotifications()
    }

    public func withdraw(_ identifiers: [String]) {
      center.removeDeliveredNotifications(withIdentifiers: identifiers)
    }

    public func withdrawAll() {
      center.removeAllDeliveredNotifications()
    }

    public func couldNotDecide(ask id: String) {
      let content = UNMutableNotificationContent()
      content.title = "KOS could not be reached"
      content.body = "Open KOS to decide it."
      content.userInfo = ["kos": ["ask": id]]
      content.categoryIdentifier = PushNote.askCategory
      center.add(UNNotificationRequest(identifier: PushNote.identifier(ask: id), content: content, trigger: nil))
    }

    private static func permission(_ status: UNAuthorizationStatus) -> PushPermission {
      switch status {
      case .notDetermined: .undecided
      case .authorized, .provisional, .ephemeral: .allowed
      default: .denied
      }
    }
  }
#endif
