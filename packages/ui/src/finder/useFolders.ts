import { useCallback, useEffect, useRef, useState } from "react";

import { api, type DirEntry } from "../api.js";

/**
 * The folders on screen, read and kept: the one being looked at, the ones
 * opened under it in the list, each column. Each is read once when it
 * appears and again every few seconds while it is on screen, so a file an
 * agent writes shows up; a folder that went away says so.
 */

const POLL_MS = 5000;

export interface FolderState {
  entries?: DirEntry[];
  error?: string;
}

export interface Folders {
  get: (path: string) => FolderState;
  /** Read every folder on screen again now, after something changed them. */
  reload: () => void;
}

export function useFolders(visible: string[], paused = false): Folders {
  const [folders, setFolders] = useState<Map<string, FolderState>>(() => new Map());
  const shown = useRef(visible);
  shown.current = visible;
  const key = visible.join("\n");

  const read = useCallback((paths: string[]) => {
    for (const path of paths) {
      void api
        .files(path)
        .then((res) => setFolders((m) => new Map(m).set(path, { entries: res.entries })))
        .catch((err: unknown) => setFolders((m) => new Map(m).set(path, { error: err instanceof Error ? err.message : String(err) })));
    }
  }, []);

  // A folder newly on screen is read at once; one already read stays as it was until the next poll.
  useEffect(() => {
    if (paused) return;
    read(shown.current.filter((p) => !folders.has(p)));
    // `folders` is read for what is missing, not watched: a read landing must not start another.
  }, [key, paused, read]);

  useEffect(() => {
    if (paused) return undefined;
    const t = setInterval(() => {
      if (document.visibilityState !== "hidden") read(shown.current);
    }, POLL_MS);
    return () => clearInterval(t);
  }, [paused, read]);

  return {
    get: (path) => folders.get(path) ?? {},
    reload: () => read(shown.current),
  };
}
