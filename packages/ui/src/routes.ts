/** Hash routes for the ops UI. */

export type Route =
  | { name: "home" }
  | { name: "projects" }
  | { name: "crons" }
  | { name: "memory" }
  | { name: "tools" }
  | { name: "runs" }
  | { name: "chats"; id?: string }
  | { name: "files"; path?: string }
  | { name: "settings" }
  | { name: "agents" }
  | { name: "page"; id: string };

export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#/, "") || "/";
  const path = h.startsWith("/") ? h : `/${h}`;
  if (path === "/" || path === "") return { name: "home" };
  if (path === "/projects") return { name: "projects" };
  if (path === "/chats") return { name: "chats" };
  if (path === "/files") return { name: "files" };
  if (path === "/settings") return { name: "settings" };
  if (path === "/agents") return { name: "agents" };
  const file = path.match(/^\/files\/(.+)$/);
  if (file?.[1]) return { name: "files", path: decodeURIComponent(file[1]) };
  const chat = path.match(/^\/chats\/([^/]+)$/);
  if (chat?.[1]) return { name: "chats", id: decodeURIComponent(chat[1]) };
  // The label is what a reader sees, so it is what they type or bookmark.
  // Without these, /knowledge silently rendered Home.
  if (path === "/crons" || path === "/schedule") return { name: "crons" };
  if (path === "/memory" || path === "/knowledge") return { name: "memory" };
  if (path === "/tools" || path === "/activity") return { name: "tools" };
  if (path === "/runs") return { name: "runs" };
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
  { route: { name: "memory" }, label: "Knowledge" },
  { route: { name: "tools" }, label: "Activity" },
  { route: { name: "runs" }, label: "Runs" },
];
