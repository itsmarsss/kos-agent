#!/usr/bin/env bash
# Builds "KOS Device.app" into build/, signed ad hoc. --install copies it to ~/Applications.
set -euo pipefail

cd "$(dirname "$0")/.."
APP="build/KOS Device.app"

swift build -c release --product KOSDevice
BIN="$(swift build -c release --show-bin-path)/KOSDevice"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/KOS Device"
cp Resources/Info.plist "$APP/Contents/Info.plist"

ICONSET="build/AppIcon.iconset"
rm -rf "$ICONSET"
swift scripts/icon.swift "$ICONSET"
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
rm -rf "$ICONSET"

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
  echo "Built $APP, signed with your KOS Device key"
else
  codesign --force --deep --sign - "$APP"
  echo "Built $APP, signed ad hoc (scripts/signing.sh setup keeps its permissions across builds)"
fi

if [[ "${1:-}" == "--install" ]]; then
  mkdir -p "$HOME/Applications"
  rm -rf "$HOME/Applications/KOS Device.app"
  cp -R "$APP" "$HOME/Applications/"
  echo "Installed to ~/Applications/KOS Device.app"
fi
