import DeviceCore
import DeviceUI
import Foundation

/// Each KOS's face as it last sent it, by this Mac's device id there, so a
/// KOS looks like itself while it is offline too. Not a secret, so not in
/// the Keychain: in this app's defaults.
@MainActor
enum FaceStore {
  private static let key = "facesByKOS"

  static func face(for id: String, in defaults: UserDefaults = .standard) -> FaceDrawing? {
    all(defaults)[id]
  }

  /// Kept when it is new; false when it is the face already kept.
  @discardableResult
  static func keep(_ face: FaceDrawing, for id: String, in defaults: UserDefaults = .standard) -> Bool {
    var faces = all(defaults)
    guard faces[id] != face else { return false }
    faces[id] = face
    save(faces, defaults)
    return true
  }

  static func forget(_ id: String, in defaults: UserDefaults = .standard) {
    var faces = all(defaults)
    guard faces.removeValue(forKey: id) != nil else { return }
    save(faces, defaults)
  }

  private static func all(_ defaults: UserDefaults) -> [String: FaceDrawing] {
    guard let data = defaults.data(forKey: key) else { return [:] }
    return (try? JSONDecoder().decode([String: FaceDrawing].self, from: data)) ?? [:]
  }

  private static func save(_ faces: [String: FaceDrawing], _ defaults: UserDefaults) {
    if let data = try? JSONEncoder().encode(faces) { defaults.set(data, forKey: key) }
  }
}
