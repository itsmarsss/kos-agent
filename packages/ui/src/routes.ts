/** Hash routes for the ops UI. */

export type Route =
  | { name: "home" }
  | { name: "projects" }
  | { name: "crons" }
  | { name: "memory" }
  | { name: "history" }
  | { name: "chats"; id?: string }
  | { name: "files"; path?: string }
  | { name: "settings"; section?: string }
  | { name: "agents"; id?: number }
  | { name: "page"; id: string };

export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#/, "") || "/";
  const path = h.startsWith("/") ? h : `/${h}`;
  if (path === "/" || path === "") return { name: "home" };
  if (path === "/projects") return { name: "projects" };
  if (path === "/chats") return { name: "chats" };
  if (path === "/files") return { name: "files" };
  if (path === "/settings") return { name: "settings" };
  const settings = path.match(/^\/settings\/([a-z]+)$/);
  if (settings?.[1]) return { name: "settings", section: settings[1] };
  if (path === "/agents") return { name: "agents" };
  const agent = path.match(/^\/agents\/(\d+)$/);
  if (agent?.[1]) return { name: "agents", id: Number(agent[1]) };
  const file = path.match(/^\/files\/(.+)$/);
  if (file?.[1]) return { name: "files", path: decodeURIComponent(file[1]) };
  const chat = path.match(/^\/chats\/([^/]+)$/);
  if (chat?.[1]) return { name: "chats", id: decodeURIComponent(chat[1]) };
  // The label is what a reader sees, so it is what they type or bookmark.
  // Without these, /knowledge silently rendered Home.
  if (path === "/crons" || path === "/schedule") return { name: "crons" };
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
      return "#/";
    case "page":
      return `#/page/${encodeURIComponent(route.id)}`;
    case "chats":
      return route.id ? `#/chats/${encodeURIComponent(route.id)}` : "#/chats";
    case "files":
      return route.path ? `#/files/${encodeURIComponent(route.path)}` : "#/files";
    case "agents":
      return route.id ? `#/agents/${route.id}` : "#/agents";
    case "settings":
      return route.section ? `#/settings/${route.section}` : "#/settings";
    default:
      return `#/${route.name}`;
  }
}

/**
 * Primary nav.
 *
 * Home is deliberately absent: it is reached by the wordmark, the way a site's
 * logo has meant home for thirty years, which buys back a slot in a bar that
 * had nine.
 * Labels name what you would go looking for, not the table the
 * data happens to live in: "Ops / Tools / Runs" told you nothing unless you
 * had read the source.
 */
export const NAV: Array<{ route: Route; label: string }> = [
  { route: { name: "chats" }, label: "Chats" },
  { route: { name: "files" }, label: "Files" },
  { route: { name: "projects" }, label: "Projects" },
  { route: { name: "agents" }, label: "Agents" },
  { route: { name: "crons" }, label: "Schedule" },
  { route: { name: "memory" }, label: "Memory" },
  { route: { name: "history" }, label: "History" },
];
