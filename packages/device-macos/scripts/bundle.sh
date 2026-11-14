#!/usr/bin/env bash
# Builds "KOS for Mac.app" into build/, signed ad hoc. --install puts it in ~/Applications in
# place of the running one and opens it. The app carries its build (docs/computer.md, Builds),
# stamped by the checkout's own tool once KOS's packages are built (pnpm build). A plain build without
# it is unstamped, which KOS reads as a build it does not know; an install without it stops instead.
set -euo pipefail

cd "$(dirname "$0")/.."
APP="build/KOS for Mac.app"
STAMP="../computer/dist/stamp.js"
# KOS runs this with its own Node, which a launchd PATH may not have.
NODE="${KOS_NODE:-node}"
INSTALL=false
[[ "${1:-}" == "--install" ]] && INSTALL=true

# shellcheck source=lock.sh
source scripts/lock.sh
LOCK="build/.install.lock"
mkdir -p build
take_lock "$LOCK"
KEYCHAINS=""
# Whatever stops it: the lock goes, and the keychain search list is put back if signing changed it.
cleanup() {
  # shellcheck disable=SC2086
  [[ -n "$KEYCHAINS" ]] && security list-keychains -d user -s $KEYCHAINS
  drop_lock "$LOCK"
}
trap cleanup EXIT

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
if [[ -f "$STAMP" ]] && "$NODE" "$STAMP" mac "$APP/Contents/Resources/build.json"; then
  echo "Stamped its build"
elif $INSTALL; then
  echo "Could not stamp the build, so nothing was installed; build KOS first (pnpm build) and run this again" >&2
  exit 1
else
  echo "warning: built unstamped; build KOS first (pnpm build) so KOS knows which build this is" >&2
fi

# With a key of the owner's own (scripts/signing.sh setup), every build is the same
# app to macOS and keeps its permissions; without one, ad hoc.
if IDENTITY="$(scripts/signing.sh identity 2>/dev/null)" && [[ -n "$IDENTITY" ]]; then
  KEYCHAIN="${KOS_DEVICE_SIGNING_KEYCHAIN:-$HOME/Library/Keychains/kos-device-signing.keychain-db}"
  # codesign finds the key only on the search list, so the keychain joins it for the signing and leaves after.
  KEYCHAINS=$(security list-keychains -d user | tr -d '"' | xargs)
  # shellcheck disable=SC2086
  security list-keychains -d user -s $KEYCHAINS "$KEYCHAIN"
  # A locked key makes macOS ask for its PIN here.
  codesign --force --deep --sign "$IDENTITY" "$APP"
  echo "Built $APP, signed with your KOS for Mac key"
else
  codesign --force --deep --sign - "$APP"
  echo "Built $APP, signed ad hoc (scripts/signing.sh setup keeps its permissions across builds)"
fi

if $INSTALL; then
  scripts/install.sh "$APP"
fi
