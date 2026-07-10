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

export const NAV: Array<{ route: Route; label: string }> = [
  { route: { name: "home" }, label: "Ops" },
  { route: { name: "projects" }, label: "Projects" },
  { route: { name: "tools" }, label: "Tools" },
  { route: { name: "crons" }, label: "Crons" },
  { route: { name: "memory" }, label: "Memory" },
  { route: { name: "runs" }, label: "Runs" },
];
