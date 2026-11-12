import DeviceCore
import Foundation

/// The little the phone keeps between launches that is not a secret: whether it reads replies aloud, and the
/// look and face of the KOS it is paired with as that KOS last sent them, so the app opens in them.
public protocol Preferences: AnyObject {
  func data(forKey key: String) -> Data?
  func set(_ data: Data?, forKey key: String)
}

extension UserDefaults: Preferences {
  public func set(_ data: Data?, forKey key: String) {
    if let data { set(data as Any, forKey: key) } else { removeObject(forKey: key) }
  }
}

/// Preferences held in memory, for tests and previews.
public final class MemoryPreferences: Preferences {
  private var values: [String: Data] = [:]

  public init() {}

  public func data(forKey key: String) -> Data? { values[key] }
  public func set(_ data: Data?, forKey key: String) { values[key] = data }
}

extension Preferences {
  func value<T: Codable>(_ type: T.Type, _ key: String) -> T? {
    data(forKey: key).flatMap { try? JSONDecoder().decode(T.self, from: $0) }
  }

  func setValue<T: Codable>(_ value: T?, _ key: String) {
    set(value.flatMap { try? JSONEncoder().encode($0) }, forKey: key)
  }
}
