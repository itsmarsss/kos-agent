import DeviceCore
import DeviceLink
import Foundation

/// The line to KOS, as the phone uses it: DeviceLink's Connection, or a
/// stand-in a test drives by hand.
@MainActor
public protocol Line: AnyObject {
  var onStatus: ((Connection.Status) -> Void)? { get set }
  var onCall: ((Call) async -> Data?)? { get set }
  var onRemoved: (() -> Void)? { get set }
  var onFace: ((FaceDrawing) -> Void)? { get set }
  var onTheme: ((DashboardTheme) -> Void)? { get set }
  var onUpdate: ((UpdateNotice) -> Void)? { get set }
  var state: () -> DeviceState { get set }

  func start(_ pairing: Pairing)
  func hold(_ pairing: Pairing)
  func redialNow()
  /// One frame; `done` is told once it went, or could not go.
  func send(_ data: Data, done: (@MainActor () -> Void)?)
  func unpair(then done: @escaping () -> Void)
  func stop()
}

extension Connection: Line {}

extension DeviceState {
  /// What a phone tells KOS about itself: the owner allows anything there is to allow on it, and it offers no
  /// screen, no input and no displays, so KOS has nothing of it to work (docs/computer.md, A phone).
  public static let phone = DeviceState(consent: .device, permissions: Permissions(screen: false, input: false), displays: [])
}
