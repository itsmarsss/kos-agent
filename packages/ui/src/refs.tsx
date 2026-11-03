import { RefLinks } from "@kos/kit";
import { useMemo, type ReactElement, type ReactNode } from "react";

import { useOpenTab } from "./opentab.js";
import { hrefFor } from "./routes.js";

/**
 * Where a reference in KOS's words goes on the dashboard: each kind to its
 * page, and a tab to the browser window, which opens on it in place. The
 * kit's Markdown draws the chip; this says where it leads.
 */

/** Where a reference goes when it is clicked. */
export function refHref(kind: string, id: string): string {
  switch (kind) {
    case "tab":
      // Opened in place by the chip; the page is only where it lands without that.
      return hrefFor({ name: "home" });
    case "page":
      return hrefFor({ name: "page", id });
    case "file":
      return hrefFor({ name: "files", path: id });
    case "approval":
      return hrefFor({ name: "inbox", id: Number(id) });
    case "schedule":
      return hrefFor({ name: "crons", job: id });
    case "chat":
      return hrefFor({ name: "chats", id });
    case "blob":
    case "agent":
      return hrefFor({ name: "blobs", blob: id });
    case "build":
      return hrefFor({ name: "builds", id: Number(id) });
    case "site":
      // Written as project/name, which is also where it lives. The site
      // server is a different origin, so this goes to the folder rather than
      // to a URL this page cannot know.
      return hrefFor({
        name: "files",
        path: `projects/${id.replace("/", "/sites/")}`,
      });
    case "project":
      return hrefFor({ name: "project", slug: id });
    default:
      return hrefFor({ name: "projects" });
  }
}

/** The dashboard's routes, for every reference drawn under it. */
export function DashboardRefs({ children }: { children: ReactNode }): ReactElement {
  const openTab = useOpenTab();
  const links = useMemo<RefLinks>(
    () => ({
      hrefOf: refHref,
      // A tab has no page of its own: the chip opens the browser window on it.
      open: (kind, id) => {
        if (kind !== "tab" || !openTab) return false;
        openTab(id);
        return true;
      },
    }),
    [openTab],
  );
  return <RefLinks.Provider value={links}>{children}</RefLinks.Provider>;
}
