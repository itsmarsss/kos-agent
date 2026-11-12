#if os(iOS) && canImport(AppIntents)
  import AppIntents
  import PhoneCore

  /// Ask KOS: opens the app listening, from Siri, Shortcuts or the Action button (README, Hands-free). It runs in the
  /// app, which it opens, and only asks it to listen: it carries no words, so nothing is said for the owner.
  public struct AskKOS: AppIntent {
    public static let title: LocalizedStringResource = "Ask KOS"
    public static let description = IntentDescription("Opens KOS listening, so you can speak to it at once.")
    public static let openAppWhenRun = true

    public init() {}

    @MainActor
    public func perform() async throws -> some IntentResult {
      HandsFree.shared.ask()
      return .result()
    }
  }

  /// This package's intents, for the app's own package list to take in.
  public struct PhoneIntents: AppIntentsPackage {}
#endif
