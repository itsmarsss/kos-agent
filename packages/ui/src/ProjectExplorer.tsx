import type { ReactElement } from "react";
import { Card } from "@kos/kit";

import type { Attachment } from "./api.js";
import { Finder } from "./finder/Finder.js";

/**
 * The project's folder, browsed in place: the same file manager as the
 * Files page, kept inside the project's folder and without the sidebar, so
 * the two places a file is seen offer the same handles. In the narrow
 * column beside a chat it is one column, its Quick Look a sheet.
 */

export interface ProjectExplorerProps {
  /** What the root is called: the project's slug, an agent's name. */
  label: string;
  /** The folder, workspace-relative. */
  root: string;
  /** How a file gets in, given the folder relative to `root`: absent, the workspace's own upload. */
  upload?: (file: Attachment, dir: string) => Promise<unknown>;
  /** Open this path on the Files page. Taken only when asked for. */
  onOpenInFiles: (path: string) => void;
  /** Ask KOS about these files, in a chat that references them. */
  onAsk?: (paths: string[]) => void;
  /** Something changed that the rest of the dashboard lists too. */
  onChanged: () => void;
  /** Off screen: nothing is polled until it is back. */
  paused?: boolean;
}

export function ProjectExplorer({ label, root, upload, onOpenInFiles, onAsk, onChanged, paused = false }: ProjectExplorerProps): ReactElement {
  return (
    <Card title="Files & folders" className="project-panel-section project-files">
      <Finder
        key={root}
        root={root}
        rootName={label}
        sidebar={false}
        {...(upload ? { upload: (file: Attachment, dir: string) => upload(file, dir === root ? "" : dir.slice(root.length + 1)) } : {})}
        onOpenInFiles={onOpenInFiles}
        {...(onAsk ? { onAsk } : {})}
        onChanged={onChanged}
        paused={paused}
      />
    </Card>
  );
}
