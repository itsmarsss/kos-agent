/** Hash routes for the ops UI. */

export type Route =
  | { name: "home" }
  | { name: "inbox"; id?: number }
  | { name: "projects" }
  /**
   * One project's workspace: its orchestrator and agent threads, with its
   * files, pages and tables beside them. `id` is the thread open in it; none
   * means the orchestrator.
   */
  | { name: "project"; slug: string; id?: string }
  | { name: "crons"; job?: string }
  | { name: "memory" }
  | { name: "history" }
  | { name: "chats"; id?: string }
  | { name: "files"; path?: string }
  | { name: "settings"; section?: string }
  /** The blobs; `blob` is the one whose page is open, "new" for a blank editor. */
  | { name: "blobs"; blob?: string }
  /** Coding sub-agents, the builds; `id` opens one's log. */
  | { name: "builds"; id?: number }
  | { name: "page"; id: string };

/**
 * What the page transition is keyed on: the page that is open, not only
 * the route's name. The blobs index and a blob's own page are both "blobs",
 * and one project's page and another's are both "project", so keyed on the
 * name alone those swapped with no motion while every other change of page
 * faded. A chat opened inside a page keeps the page's key: the page stays,
 * its thread changes.
 */
export function pageKeyOf(route: Route): string {
  switch (route.name) {
    case "blobs":
      return route.blob && route.blob !== "new" ? `blobs:${route.blob}` : "blobs";
    case "project":
      return `project:${route.slug}`;
    default:
      return route.name;
  }
}

export function parseRoute(hash: string): Route {
  // A query on a hash route (#/memory?tab=log) is the page's own business;
  // it used to make the whole route unrecognised and land on the overview.
  const h = (hash.replace(/^#/, "").split("?")[0] ?? "") || "/";
  const path = h.startsWith("/") ? h : `/${h}`;
  // Opening KOS is opening a conversation: that is what it is for. The
  // overview is a page of its own now.
  if (path === "/" || path === "") return { name: "chats" };
  if (path === "/home" || path === "/overview") return { name: "home" };
  if (path === "/inbox") return { name: "inbox" };
  // An approval by its number, waiting or decided, so a chat can link to it.
  const approval = path.match(/^\/inbox\/(\d+)$/);
  if (approval?.[1]) return { name: "inbox", id: Number(approval[1]) };
  if (path === "/projects") return { name: "projects" };
  const project = path.match(/^\/project\/([^/]+)(?:\/([^/]+))?$/);
  if (project?.[1]) {
    const slug = decodeURIComponent(project[1]);
    return project[2] ? { name: "project", slug, id: decodeURIComponent(project[2]) } : { name: "project", slug };
  }
  if (path === "/chats") return { name: "chats" };
  if (path === "/files") return { name: "files" };
  if (path === "/settings") return { name: "settings" };
  const settings = path.match(/^\/settings\/([a-z]+)$/);
  if (settings?.[1]) return { name: "settings", section: settings[1] };
  if (path === "/builds") return { name: "builds" };
  const build = path.match(/^\/builds\/(\d+)$/);
  if (build?.[1]) return { name: "builds", id: Number(build[1]) };
  if (path === "/blobs" || path === "/agents") return { name: "blobs" };
  // A build's log was at /agents/<id> before builds had a page of their own;
  // a number there still opens that log.
  const oldBuild = path.match(/^\/agents\/(\d+)$/);
  if (oldBuild?.[1]) return { name: "builds", id: Number(oldBuild[1]) };
  // Blobs were agents first; a link from then still opens the blob.
  const blob = path.match(/^\/(?:blobs|agents)\/([^/]+)$/);
  if (blob?.[1]) return { name: "blobs", blob: decodeURIComponent(blob[1]) };
  const file = path.match(/^\/files\/(.+)$/);
  if (file?.[1]) return { name: "files", path: decodeURIComponent(file[1]) };
  const chat = path.match(/^\/chats\/([^/]+)$/);
  if (chat?.[1]) return { name: "chats", id: decodeURIComponent(chat[1]) };
  // The label is what a reader sees, so it is what they type or bookmark.
  // Without these, /knowledge silently rendered Home.
  if (path === "/crons" || path === "/schedule") return { name: "crons" };
  // A job by name opens its drawer, so a schedule can be linked to from a chat.
  const job = path.match(/^\/(?:crons|schedule)\/([^/]+)$/);
  if (job?.[1]) return { name: "crons", job: decodeURIComponent(job[1]) };
  if (path === "/memory" || path === "/knowledge") return { name: "memory" };
  // Activity and Runs were two pages of the same thing. Their paths still
  // resolve, because a bookmark should not break when two pages become one.
  if (
    path === "/history" ||
    path === "/tools" ||
    path === "/activity" ||
    path === "/runs"
  ) {
    return { name: "history" };
  }
  const page = path.match(/^\/page\/([^/]+)$/);
  if (page?.[1]) return { name: "page", id: decodeURIComponent(page[1]) };
  return { name: "home" };
}

export function hrefFor(route: Route): string {
  switch (route.name) {
    case "home":
      return "#/home";
    case "page":
      return `#/page/${encodeURIComponent(route.id)}`;
    case "project":
      return route.id
        ? `#/project/${encodeURIComponent(route.slug)}/${encodeURIComponent(route.id)}`
        : `#/project/${encodeURIComponent(route.slug)}`;
    case "chats":
      return route.id ? `#/chats/${encodeURIComponent(route.id)}` : "#/chats";
    case "files":
      return route.path ? `#/files/${encodeURIComponent(route.path)}` : "#/files";
    case "blobs":
      return route.blob ? `#/blobs/${encodeURIComponent(route.blob)}` : "#/blobs";
    case "builds":
      return route.id ? `#/builds/${route.id}` : "#/builds";
    case "crons":
      return route.job ? `#/schedule/${encodeURIComponent(route.job)}` : "#/schedule";
    case "inbox":
      return route.id !== undefined ? `#/inbox/${route.id}` : "#/inbox";
    case "settings":
      return route.section ? `#/settings/${route.section}` : "#/settings";
    default:
      return `#/${route.name}`;
  }
}

/**
 * Primary nav, in the sidebar.
 *
 * Chats first because that is what KOS is for. Inbox second because it is
 * the one place everything waiting on you is listed. Blobs are the
 * responsibilities KOS keeps for you, so they sit with Projects. Builds,
 * Schedule and History are one entry, Runs: they are all what KOS does on
 * its own, and none of them is a daily visit.
 * Labels name what you would go looking for, not the table the
 * data happens to live in: "Ops / Tools / Runs" told you nothing unless you
 * had read the source.
 */
export const NAV: Array<{ route: Route; label: string }> = [
  // Overview first: it is the page that says what needs you before you
  // pick a chat. Chats stays the default route, since that is what KOS is for.
  { route: { name: "home" }, label: "Overview" },
  { route: { name: "chats" }, label: "Chats" },
  { route: { name: "inbox" }, label: "Inbox" },
  { route: { name: "projects" }, label: "Projects" },
  { route: { name: "blobs" }, label: "Blobs" },
  { route: { name: "files" }, label: "Files" },
  { route: { name: "memory" }, label: "Memory" },
  { route: { name: "history" }, label: "Runs" },
];

/** The Runs entry covers three routes; this says which. */
export const RUNS_ROUTES: ReadonlySet<Route["name"]> = new Set(["history", "crons", "builds"]);

/** Whether a nav entry is the one the current route belongs to. */
export function navActive(item: Route, route: Route): boolean {
  if (item.name === "history") return RUNS_ROUTES.has(route.name);
  if (item.name === "projects") {
    return route.name === "projects" || route.name === "project" || route.name === "page";
  }
  return item.name === route.name;
}
