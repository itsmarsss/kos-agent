#!/usr/bin/env bash
# Puts a built KOS for Mac.app in ~/Applications in place of the running one, and opens it: bundle.sh --install.
# The new copy is renamed into place, so a stop at any point leaves an app installed; one that will not quit is
# not replaced, and the script says so and fails. KOS_DEVICE_OPEN names what opens it (a test's stand-in).
set -euo pipefail
APP="${1:?the built app}"
APPS="$HOME/Applications"
INSTALLED="$APPS/KOS for Mac.app"
# The new copy goes in beside the old first, and is renamed into place, so a stop at any point leaves an app there.
NEXT="$APPS/.KOS for Mac.app.next"
mkdir -p "$APPS"
rm -rf "$NEXT"
cp -R "$APP" "$NEXT"
# A running copy keeps its old code until it quits: quit it and wait until it has, then open the new one.
# Told with a signal, which it takes as Quit: an Apple Event would ask the owner's leave when KOS runs this.
# The app was KOS Device before; that copy goes too, or two would hold the same pairings.
for OLD in "$INSTALLED" "$APPS/KOS Device.app"; do
  if pgrep -qf "$OLD/Contents/MacOS/"; then
    pkill -TERM -f "$OLD/Contents/MacOS/" || true
    for _ in {1..50}; do
      pgrep -qf "$OLD/Contents/MacOS/" || break
      sleep 0.2
    done
    # Still open: replacing it now would leave the old one running. Nothing is replaced, and the reason is said.
    if pgrep -qf "$OLD/Contents/MacOS/"; then
      rm -rf "$NEXT"
      echo "$(basename "$OLD" .app) did not quit within 10 seconds, so nothing was replaced; quit it from its menu and run this again" >&2
      exit 1
    fi
  fi
done
rm -rf "$APPS/KOS Device.app" "$INSTALLED.old"
[[ -e "$INSTALLED" ]] && mv "$INSTALLED" "$INSTALLED.old"
mv "$NEXT" "$INSTALLED"
rm -rf "$INSTALLED.old"
"${KOS_DEVICE_OPEN:-open}" "$INSTALLED"
echo "Installed to ~/Applications/KOS for Mac.app and opened it"
