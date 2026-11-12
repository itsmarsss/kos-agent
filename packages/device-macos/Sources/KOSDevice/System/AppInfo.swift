import DeviceCore
import Foundation

extension AppInfo {
  /// What this app says it is in each hello: its version, macOS, and which macOS.
  static var mac: AppInfo {
    let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.1.0"
    let os = ProcessInfo.processInfo.operatingSystemVersion
    return AppInfo(version: version, os: "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)")
  }
}
