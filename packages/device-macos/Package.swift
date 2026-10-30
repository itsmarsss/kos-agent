// swift-tools-version:5.10
import PackageDescription

let package = Package(
  name: "KOSDevice",
  platforms: [.macOS(.v14)],
  targets: [
    // The rules and the wire format, with no AppKit in them, so all of it is tested.
    .target(name: "DeviceCore"),
    .testTarget(name: "DeviceCoreTests", dependencies: ["DeviceCore"]),
  ]
)
