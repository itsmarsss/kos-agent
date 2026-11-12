// swift-tools-version:5.10
import PackageDescription

// What KOS for Mac and KOS for iPhone share: the wire, the look and the line.
// Nothing here is one platform's own, so all of it builds for both and is tested on a Mac.
let package = Package(
  name: "DeviceShared",
  platforms: [.macOS(.v14), .iOS(.v17)],
  products: [
    .library(name: "DeviceCore", targets: ["DeviceCore"]),
    .library(name: "DeviceKit", targets: ["DeviceKit"]),
    .library(name: "DeviceLink", targets: ["DeviceLink"]),
  ],
  targets: [
    // The rules and the wire format, Foundation alone, so all of it is tested.
    .target(name: "DeviceCore"),
    // KOS's look in SwiftUI, and the chat as a device draws it: the kit both apps are drawn from.
    .target(name: "DeviceKit", dependencies: ["DeviceCore"]),
    // The line to KOS and pairing with it: dialled out, proven both ways, pinned where it must be.
    .target(name: "DeviceLink", dependencies: ["DeviceCore"]),
    .testTarget(name: "DeviceCoreTests", dependencies: ["DeviceCore"]),
    .testTarget(name: "DeviceKitTests", dependencies: ["DeviceKit", "DeviceCore"]),
    .testTarget(name: "DeviceLinkTests", dependencies: ["DeviceLink", "DeviceCore"]),
  ]
)
