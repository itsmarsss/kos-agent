import DeviceCore
import DeviceLink
import Foundation
import OSLog

#if os(iOS)
import UIKit
#endif

extension Phone {
  /// The phone over this device's own adapters: on an iPhone, the Keychain, its speech recognition and its
  /// haptics; on a Mac, where the app runs only to be looked at, pairings in memory and no microphone.
  public static func onThisDevice() -> Phone {
    let log = Logger(subsystem: "com.itsmarsss.kos-phone", category: "line")
    let app = AppInfo.phone
    // Stamped into the app by its Xcode build phase (README); none from `swift run`.
    let build = Build.stamped()
    #if os(iOS)
    return Phone(
      vault: KeychainVault(service: "KOS for iPhone"), pairer: NetworkPairer(), recognizer: SystemSpeechRecognizer(), speaker: SystemSpeaker(),
      haptics: SystemHaptics(), preferences: UserDefaults.standard, line: { Connection(log: log, app: app, build: build) })
    #else
    return Phone(
      vault: MemoryVault(), pairer: NetworkPairer(), recognizer: NoSpeech(), speaker: SystemSpeaker(), haptics: SystemHaptics(),
      preferences: MemoryPreferences(), line: { Connection(log: log, app: app, build: build) }, name: "KOS for iPhone on a Mac")
    #endif
  }
}

extension AppInfo {
  /// What this app says it is in each hello: its version, the platform KOS knows a phone by, and which iOS.
  @MainActor
  public static var phone: AppInfo {
    let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.1.0"
    #if os(iOS)
    let os = UIDevice.current.systemVersion
    #else
    let v = ProcessInfo.processInfo.operatingSystemVersion
    let os = "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
    #endif
    return AppInfo(version: version, platform: Phone.platform, os: os)
  }
}
