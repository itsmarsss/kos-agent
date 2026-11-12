import PhoneUI
import SwiftUI

#if os(iOS)
  import AppIntents
#endif

/// KOS for iPhone. The whole app is PhoneScene; this is the one file an iOS app target needs (README).
@main
struct KOSPhoneApp: App {
  var body: some Scene {
    PhoneScene()
  }
}

#if os(iOS)
  /// Ask KOS as Siri, Shortcuts and the Action button offer it, with the phrases that start it.
  struct KOSShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
      AppShortcut(intent: AskKOS(), phrases: ["Ask \(.applicationName)", "Talk to \(.applicationName)"], shortTitle: "Ask KOS", systemImageName: "mic.fill")
    }
  }

  /// The intents PhoneUI defines, taken into the app's.
  struct KOSIntents: AppIntentsPackage {
    static var includedPackages: [any AppIntentsPackage.Type] { [PhoneIntents.self] }
  }
#endif
