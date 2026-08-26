/** Hash routes for the ops UI. */

export type Route =
  | { name: "home" }
  | { name: "projects" }
  | { name: "crons" }
  | { name: "memory" }
  | { name: "tools" }
  | { name: "runs" }
  | { name: "page"; id: string };

export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#/, "") || "/";
  const path = h.startsWith("/") ? h : `/${h}`;
  if (path === "/" || path === "") return { name: "home" };
  if (path === "/projects") return { name: "projects" };
  if (path === "/crons") return { name: "crons" };
  if (path === "/memory") return { name: "memory" };
  if (path === "/tools") return { name: "tools" };
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
    default:
      return `#/${route.name}`;
  }
}

/**
 * Primary nav. Labels name what you would go looking for, not the table the
 * data happens to live in: "Ops / Tools / Runs" told you nothing unless you
 * had read the source.
 */
export const NAV: Array<{ route: Route; label: string }> = [
  { route: { name: "home" }, label: "Home" },
  { route: { name: "projects" }, label: "Projects" },
  { route: { name: "crons" }, label: "Schedule" },
  { route: { name: "memory" }, label: "What it knows" },
  { route: { name: "tools" }, label: "Activity" },
  { route: { name: "runs" }, label: "Runs" },
];
