import DeviceCore
import Foundation
import Security

/// Where a device keeps its pairings: each KOS's address, its pinned key and
/// the device's own private key for it.
public protocol PairingVault: Sendable {
  /// The saved pairings, none when none were saved; throws when the store will not give them up.
  func load() throws -> [Pairing]
  /// The list, in place of the one kept; an empty one removes it.
  func save(_ list: [Pairing]) throws
}

/// The pairings in the Keychain, as one item: readable by this app only, on this device only, once it has been
/// unlocked since it started, and never in a backup.
public struct KeychainVault: PairingVault {
  private let service: String
  private let account: String

  public init(service: String, account: String = "pairings") {
    self.service = service
    self.account = account
  }

  private var query: [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
  }

  public func load() throws -> [Pairing] {
    var lookup = query
    lookup[kSecReturnData as String] = true
    lookup[kSecMatchLimit as String] = kSecMatchLimitOne
    var found: CFTypeRef?
    let status = SecItemCopyMatching(lookup as CFDictionary, &found)
    if status == errSecItemNotFound { return [] }
    guard status == errSecSuccess, let data = found as? Data else {
      throw DeviceError(.internal, "The Keychain would not give up the pairings (\(Self.describe(status))).")
    }
    do {
      return try JSONDecoder().decode([Pairing].self, from: data)
    } catch {
      throw DeviceError(.internal, "The saved pairings could not be read. Pair again.")
    }
  }

  public func save(_ list: [Pairing]) throws {
    guard !list.isEmpty else {
      SecItemDelete(query as CFDictionary)
      return
    }
    let data = try JSONEncoder().encode(list)
    // Updated where it is, so a Keychain that refuses the write leaves the old list rather than none.
    var status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if status == errSecItemNotFound {
      var item = query
      item[kSecValueData as String] = data
      item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      status = SecItemAdd(item as CFDictionary, nil)
    }
    guard status == errSecSuccess else {
      throw DeviceError(.internal, "Could not keep the pairing in the Keychain: \(Self.describe(status))")
    }
  }

  private static func describe(_ status: OSStatus) -> String {
    SecCopyErrorMessageString(status, nil) as String? ?? "status \(status)"
  }
}

/// Pairings held in memory alone, gone when the app is: for tests, and for a run that must not reach the Keychain.
public final class MemoryVault: PairingVault, @unchecked Sendable {
  private let lock = NSLock()
  private var list: [Pairing]
  /// Makes the next load or save fail, as a Keychain that refuses does.
  public var refuses = false

  public init(_ list: [Pairing] = []) {
    self.list = list
  }

  public func load() throws -> [Pairing] {
    try lock.withLock {
      if refuses { throw DeviceError(.internal, "The store refused.") }
      return list
    }
  }

  public func save(_ list: [Pairing]) throws {
    try lock.withLock {
      if refuses { throw DeviceError(.internal, "The store refused.") }
      self.list = list
    }
  }
}
