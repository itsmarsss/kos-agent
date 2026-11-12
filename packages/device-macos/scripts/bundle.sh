#!/usr/bin/env bash
# Builds "KOS for Mac.app" into build/, signed ad hoc. --install puts it in ~/Applications in
# place of the running one and opens it. The app carries its build (docs/computer.md, Builds),
# stamped by the checkout's own tool, so KOS's packages must be built first (pnpm build).
set -euo pipefail

cd "$(dirname "$0")/.."
APP="build/KOS for Mac.app"
STAMP="../computer/dist/stamp.js"
# KOS runs this with its own Node, which a launchd PATH may not have.
NODE="${KOS_NODE:-node}"
[[ -f "$STAMP" ]] || { echo "Build KOS first (pnpm build): $STAMP stamps the app's build" >&2; exit 1; }

swift build -c release --product KOSDevice
BIN="$(swift build -c release --show-bin-path)/KOSDevice"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/KOS for Mac"
cp Resources/Info.plist "$APP/Contents/Info.plist"

ICONSET="build/AppIcon.iconset"
rm -rf "$ICONSET"
swift scripts/icon.swift "$ICONSET"
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
rm -rf "$ICONSET"
"$NODE" "$STAMP" mac "$APP/Contents/Resources/build.json"

# With a key of the owner's own (scripts/signing.sh setup), every build is the same
# app to macOS and keeps its permissions; without one, ad hoc.
if IDENTITY="$(scripts/signing.sh identity 2>/dev/null)" && [[ -n "$IDENTITY" ]]; then
  KEYCHAIN="${KOS_DEVICE_SIGNING_KEYCHAIN:-$HOME/Library/Keychains/kos-device-signing.keychain-db}"
  # codesign finds the key only on the search list, so the keychain joins it for the signing and leaves after.
  LIST=$(security list-keychains -d user | tr -d '"' | xargs)
  # shellcheck disable=SC2086
  trap 'security list-keychains -d user -s $LIST' EXIT
  # shellcheck disable=SC2086
  security list-keychains -d user -s $LIST "$KEYCHAIN"
  # A locked key makes macOS ask for its PIN here.
  codesign --force --deep --sign "$IDENTITY" "$APP"
  echo "Built $APP, signed with your KOS for Mac key"
else
  codesign --force --deep --sign - "$APP"
  echo "Built $APP, signed ad hoc (scripts/signing.sh setup keeps its permissions across builds)"
fi

if [[ "${1:-}" == "--install" ]]; then
  scripts/install.sh "$APP"
fi
