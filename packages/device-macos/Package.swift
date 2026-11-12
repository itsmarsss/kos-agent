// swift-tools-version:5.10
import PackageDescription

let package = Package(
  name: "KOSDevice",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "KOSDevice", targets: ["KOSDevice"]),
  ],
  dependencies: [
    // The wire, the kit and the line, shared with KOS for iPhone.
    .package(path: "../device-shared"),
  ],
  targets: [
    // The windows, in KOS's own look, over models the app fills: nothing here reaches the system.
    // It reads DeviceCore's rules where a window offers one, as the theme, and draws from DeviceKit.
    .target(name: "DeviceUI", dependencies: [
      .product(name: "DeviceCore", package: "device-shared"),
      .product(name: "DeviceKit", package: "device-shared"),
    ]),
    // The menu bar app: screen, input, overlay and windows over DeviceCore and DeviceUI.
    .executableTarget(name: "KOSDevice", dependencies: [
      .product(name: "DeviceCore", package: "device-shared"),
      .product(name: "DeviceLink", package: "device-shared"),
      "DeviceUI",
    ]),
    .testTarget(name: "DeviceUITests", dependencies: [
      "DeviceUI",
      .product(name: "DeviceCore", package: "device-shared"),
      .product(name: "DeviceKit", package: "device-shared"),
    ]),
  ]
)
