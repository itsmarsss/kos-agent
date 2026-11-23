import { useEffect, useState, type ReactElement } from "react";

import { api } from "./api.js";
import { Finder } from "./finder/Finder.js";
import { useHashParam } from "./hashparams.js";
import { parentOf } from "./finder/model.js";

/**
 * The workspace, browsed and kept in order.
 *
 * KOS's whole premise is that everything is one folder you own, so being
 * able to see that folder is not a convenience. This is the file manager
 * over the whole workspace: its sidebar, views, Quick Look and trash. The
 * address names a folder, or a file, which opens its folder with the file
 * chosen and looked at.
 */

export interface FilesPageProps {
  path?: string;
  onOpen: (path: string) => void;
  /** Ask KOS about these, in a chat that references them. */
  onAsk?: (paths: string[]) => void;
}

export function FilesPage({ path = ".", onOpen, onAsk }: FilesPageProps): ReactElement {
  /** The address as a folder, and the file in it it names, once known. */
  const [at, setAt] = useState<{ folder: string; focus?: string } | null>(null);
  /** The line a search found in the file (`?line=` on the address). */
  const [line] = useHashParam("line");
  useEffect(() => {
    let cancelled = false;
    if (path === ".") {
      setAt({ folder: "." });
      return undefined;
    }
    void api
      .fileInfo(path)
      .then((info) => !cancelled && setAt(info.kind === "dir" ? { folder: path } : { folder: parentOf(path), focus: path }))
      // Gone, or never was: the folder it would be in.
      .catch(() => !cancelled && setAt({ folder: parentOf(path) }));
    return () => {
      cancelled = true;
    };
  }, [path]);
  if (!at) return <div className="finder finder--loading" aria-busy="true" />;
  const shown = Number(line);
  return (
    <>
      {/* The page's heading, for its outline and for the keys to land on; the path bar says where you are to the eye. */}
      <h1 className="sr-only">Files</h1>
      <Finder
        path={at.folder}
        {...(at.focus ? { focus: at.focus, ...(Number.isInteger(shown) && shown > 0 ? { focusLine: shown } : {}) } : {})}
        onNavigate={onOpen}
        {...(onAsk ? { onAsk } : {})}
      />
    </>
  );
}
