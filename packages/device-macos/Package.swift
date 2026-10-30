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
    // The menu bar app: screen, input, overlay and windows over DeviceCore.
    .executableTarget(name: "KOSDevice", dependencies: ["DeviceCore"]),
    .testTarget(name: "DeviceCoreTests", dependencies: ["DeviceCore"]),
  ]
)
