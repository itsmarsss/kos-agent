# shellcheck shell=bash
# One build at a time in build/: two (KOS's own across a restart, and the owner's) would write the same app.
# `take_lock <dir>` holds the lock as a folder with this shell's pid in it; one whose pid is gone is stale and
# taken over; one held by a live process stops this one, saying which. `drop_lock <dir>` lets it go.
take_lock() {
  local lock="$1" other
  if ! mkdir "$lock" 2>/dev/null; then
    other="$(cat "$lock/pid" 2>/dev/null || true)"
    if [[ -n "$other" ]] && kill -0 "$other" 2>/dev/null; then
      echo "Another build of KOS for Mac is running (pid $other); run this again once it has finished" >&2
      exit 1
    fi
    rm -rf "$lock"
    mkdir "$lock"
  fi
  echo "$$" > "$lock/pid"
}

drop_lock() {
  rm -rf "$1"
}
