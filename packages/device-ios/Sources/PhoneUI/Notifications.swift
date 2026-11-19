#if os(iOS)
  import DeviceCore
  import PhoneCore
  import UIKit
  import UserNotifications

  /// KOS's asks on the lock screen, as the app's delegate hears them: the token APNs gives, a push that an ask was
  /// settled, and the owner's press on a notification. Approve and Deny decide over the phone's own line, as any of
  /// its decisions does; one that does not reach KOS leaves a notification that opens the ask. A tap opens it.
  extension PhoneAppDelegate: UNUserNotificationCenterDelegate {
    public func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
      // Before launching returns, or a press that launched the app is not heard.
      let center = UNUserNotificationCenter.current()
      center.delegate = self
      center.setNotificationCategories(SystemNotifier.categories)
      return true
    }

    public func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
      MainActor.assumeIsolated { Phone.shared.push.registered(deviceToken) }
    }

    public func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
      let message = error.localizedDescription
      MainActor.assumeIsolated { Phone.shared.push.failed(message) }
    }

    /// A background push: an ask settled elsewhere, whose notification comes down.
    public func application(
      _ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any], fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
      guard let note = PushNote(userInfo: userInfo) else { return completionHandler(.noData) }
      MainActor.assumeIsolated { Phone.shared.received(note) }
      completionHandler(.newData)
    }

    /// On screen, the app shows its asks itself: the notification goes to the list, and the glance is asked again.
    nonisolated public func userNotificationCenter(
      _ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
      guard let note = PushNote(userInfo: notification.request.content.userInfo) else { return completionHandler([.banner, .list]) }
      Task { @MainActor in
        Phone.shared.received(note)
        completionHandler([.list])
      }
    }

    nonisolated public func userNotificationCenter(
      _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void
    ) {
      guard case .ask(let id) = PushNote(userInfo: response.notification.request.content.userInfo) else { return completionHandler() }
      let action = response.actionIdentifier
      Task { @MainActor in
        await Self.answer(id, action: action)
        completionHandler()
      }
    }

    @MainActor
    private static func answer(_ id: String, action: String) async {
      let phone = Phone.shared
      switch action {
      case PushNote.approveAction, PushNote.denyAction:
        if await !phone.decide(fromNotification: id, approved: action == PushNote.approveAction) { phone.couldNotDecide(id) }
      case UNNotificationDefaultActionIdentifier:
        phone.open(ask: id)
      default:
        break
      }
    }
  }
#endif
