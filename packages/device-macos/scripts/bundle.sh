#!/usr/bin/env bash
# Builds "KOS Device.app" into build/, signed ad hoc. --install puts it in ~/Applications in
# place of the running one and opens it.
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
  INSTALLED="$HOME/Applications/KOS Device.app"
  # A running copy keeps its old code until it quits: quit it and wait until it has, then open the new one.
  if pgrep -qf "$INSTALLED/Contents/MacOS/"; then
    osascript -e 'tell application "KOS Device" to quit'
    for _ in {1..50}; do
      pgrep -qf "$INSTALLED/Contents/MacOS/" || break
      sleep 0.2
    done
  fi
  mkdir -p "$HOME/Applications"
  rm -rf "$INSTALLED"
  cp -R "$APP" "$HOME/Applications/"
  open "$INSTALLED"
  echo "Installed to ~/Applications/KOS Device.app and opened it"
fi
