import { useEffect, useState } from "react";

/**
 * Whether files whose names start with a dot are shown. Off by default:
 * .kos, .git and their kind are the workspace's plumbing, and a browse of a
 * folder is for what the owner or an agent put there. Remembered in this
 * browser, since it is a way of looking rather than a fact about the files.
 */

const KEY = "kos.files.hidden";

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function useHiddenFiles(): [boolean, (show: boolean) => void] {
  const [show, setShow] = useState<boolean>(read);
  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key === KEY) setShow(read());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  return [
    show,
    (next) => {
      setShow(next);
      try {
        localStorage.setItem(KEY, next ? "1" : "0");
      } catch {
        // A browser that keeps nothing still shows the files this once.
      }
    },
  ];
}
