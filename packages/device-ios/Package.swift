// swift-tools-version:5.10
import PackageDescription

// KOS for iPhone: a chat with KOS over the home Wi-Fi, voice first.
//
// Built for iOS and, so all of it is tested and drawn without Xcode, for macOS
// too: what only an iPhone has (speech recognition, haptics, the Keychain's
// phone rules) is behind small adapters in PhoneCore, with stand-ins elsewhere.
let package = Package(
  name: "KOSPhone",
  platforms: [.iOS(.v17), .macOS(.v14)],
  products: [
    .library(name: "PhoneCore", targets: ["PhoneCore"]),
    .library(name: "PhoneUI", targets: ["PhoneUI"]),
  ],
  dependencies: [
    // The wire, the kit and the line, shared with KOS for Mac.
    .package(path: "../device-shared"),
  ],
  targets: [
    // The app's state and its rules: pairing, the line, the chat, the glance, voice in and out. No views.
    .target(name: "PhoneCore", dependencies: [
      .product(name: "DeviceCore", package: "device-shared"),
      .product(name: "DeviceKit", package: "device-shared"),
      .product(name: "DeviceLink", package: "device-shared"),
    ]),
    // The screens, in KOS's own look, over PhoneCore's models.
    .target(name: "PhoneUI", dependencies: [
      "PhoneCore",
      .product(name: "DeviceCore", package: "device-shared"),
      .product(name: "DeviceKit", package: "device-shared"),
    ]),
    // The app itself: the one file an iOS app target takes (README), run on a Mac in a phone-sized window.
    .executableTarget(name: "KOSPhoneApp", dependencies: ["PhoneUI"], path: "App", exclude: ["Info.plist"]),
    .testTarget(name: "PhoneCoreTests", dependencies: [
      "PhoneCore",
      .product(name: "DeviceCore", package: "device-shared"),
      .product(name: "DeviceKit", package: "device-shared"),
      .product(name: "DeviceLink", package: "device-shared"),
    ]),
    .testTarget(name: "PhoneUITests", dependencies: [
      "PhoneUI",
      "PhoneCore",
      .product(name: "DeviceCore", package: "device-shared"),
      .product(name: "DeviceKit", package: "device-shared"),
    ]),
  ]
)
