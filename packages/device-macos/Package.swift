// swift-tools-version:5.10
import PackageDescription

let package = Package(
  name: "KOSDevice",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "KOSDevice", targets: ["KOSDevice"]),
  ],
  targets: [
    // The rules and the wire format, with no AppKit in them, so all of it is tested.
    .target(name: "DeviceCore"),
    // The windows, in KOS's own look, over models the app fills: nothing here reaches the system.
    // It reads DeviceCore's rules where a window offers one, as the theme.
    .target(name: "DeviceUI", dependencies: ["DeviceCore"]),
    // The menu bar app: screen, input, overlay and windows over DeviceCore and DeviceUI.
    .executableTarget(name: "KOSDevice", dependencies: ["DeviceCore", "DeviceUI"]),
    .testTarget(name: "DeviceCoreTests", dependencies: ["DeviceCore"]),
    .testTarget(name: "DeviceUITests", dependencies: ["DeviceUI", "DeviceCore"]),
  ]
)
