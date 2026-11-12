#!/usr/bin/env bash
# Puts a built KOS for Mac.app in ~/Applications in place of the running one, and opens it: bundle.sh --install.
# The new copy is staged beside the old and the two are swapped by renames. Between the two renames the old copy
# is aside as .old; a stop there is undone at once (TERM, INT) or by the next run, which puts .old back first.
# One that will not quit is not replaced, and the script says so and fails. KOS_DEVICE_OPEN names what opens it
# (a test's stand-in).
set -euo pipefail
APP="${1:?the built app}"
[[ -n "${HOME:-}" && "$HOME" == /* ]] || { echo "HOME is not set to a folder; refusing to install" >&2; exit 1; }
APPS="$HOME/Applications"
INSTALLED="$APPS/KOS for Mac.app"
NEXT="$APPS/.KOS for Mac.app.next"
mkdir -p "$APPS"
# A run stopped between the renames left the old copy aside and none in place: it goes back first.
if [[ ! -e "$INSTALLED" && -e "$INSTALLED.old" ]]; then
  mv "$INSTALLED.old" "$INSTALLED"
  echo "Put back the copy a stopped install had set aside"
fi
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
# Stopped between the renames, the old copy goes back before this exits.
restore() {
  [[ ! -e "$INSTALLED" && -e "$INSTALLED.old" ]] && mv "$INSTALLED.old" "$INSTALLED"
  exit 1
}
trap restore TERM INT
[[ -e "$INSTALLED" ]] && mv "$INSTALLED" "$INSTALLED.old"
mv "$NEXT" "$INSTALLED"
trap - TERM INT
rm -rf "$INSTALLED.old"
"${KOS_DEVICE_OPEN:-open}" "$INSTALLED"
echo "Installed to ~/Applications/KOS for Mac.app and opened it"
