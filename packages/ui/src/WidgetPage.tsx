import type { ReactElement } from "react";

import type { PagePayload, Project } from "./api.js";
import { TrashNotice, useArtifactOps, type ArtifactChange } from "./ArtifactManage.js";
import { PageHistory } from "./PageHistory.js";
import { PageRenderer } from "./widgets/PageRenderer.js";

/**
 * An older widget page, opened on its own route. In the trash it is left as
 * it is, as an HTML artifact is: the trash notice with Restore and Delete
 * forever, its widgets drawn to be looked at, and no way back to a version
 * until it is restored.
 */
export function WidgetPage({ page, projects, onReload, onGone, onError }: { page: PagePayload; projects: Project[]; onReload: () => Promise<unknown>; onGone: () => void; onError: (text: string) => void }): ReactElement {
  const changed = (change: ArtifactChange): void => (change.op === "delete" ? onGone() : void onReload());
  const ops = useArtifactOps({ projects, onChanged: changed, onError });
  const trashed = page.record.trashedAt !== undefined;
  return (
    <>
      {trashed ? <TrashNotice record={page.record} ops={ops} /> : <PageHistory record={page.record} onRolledBack={onReload} />}
      <PageRenderer spec={page.spec} data={page.data} readOnly={trashed} />
    </>
  );
}
