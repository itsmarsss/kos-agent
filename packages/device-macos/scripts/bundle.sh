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

codesign --force --deep --sign - "$APP"
echo "Built $APP"

if [[ "${1:-}" == "--install" ]]; then
  mkdir -p "$HOME/Applications"
  rm -rf "$HOME/Applications/KOS Device.app"
  cp -R "$APP" "$HOME/Applications/"
  echo "Installed to ~/Applications/KOS Device.app"
fi
