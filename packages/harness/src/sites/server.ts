import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join } from "node:path";

import type { Workspace } from "../store/workspace.js";

/**
 * Serving what the agent built.
 *
 * KOS can already write a web app: files.write puts HTML, CSS and JS in the
 * workspace. What it could not do was let you look at the result, which made
 * "build me a tracker" stop one step short of the thing you asked for. This
 * serves those folders, and nothing else.
 *
 * Two properties do the safety work here, and both are structural rather than
 * careful:
 *
 * 1. **A separate origin.** A site is agent-written markup with scripts in it.
 *    Served from the dashboard's port it would sit on the dashboard's origin,
 *    where it could call /api/message, read every conversation and approve its
 *    own actions. Its own port means the browser treats it as a different
 *    site, and the dashboard's CORS allow-list is empty, so a page served here
 *    cannot reach the API at all.
 *
 * 2. **No execution.** A site is files. Nothing here spawns a process, so
 *    serving one is exactly as confined as reading one, and the workspace jail
 *    is still the whole perimeter.
 */

/**
 * Where a project's sites live, relative to the workspace root.
 *
 * Under the project rather than in a folder of their own, because a site is
 * part of a project rather than a thing beside it: the tracker, its pages and
 * its data belong together, and "everything about this is one folder" is the
 * premise KOS is built on. The URL follows the same shape, so
 * projects/expenses/sites/dashboard is served at /expenses/dashboard/.
 */
export const PROJECTS_DIR = "projects";
export const SITES_SUBDIR = "sites";

/** Workspace-relative folder holding one project's sites. */
export function sitesDirFor(projectSlug: string): string {
  return `${PROJECTS_DIR}/${projectSlug}/${SITES_SUBDIR}`;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/**
 * What a served page is allowed to do.
 *
 * Everything comes from the site itself. Inline script and style are permitted
 * because a hand-written prototype is mostly inline and the origin has no
 * authority to abuse; what is not permitted is reaching off the machine.
 * connect-src, img-src and friends being 'self' mean a page cannot beacon the
 * workspace's contents to someone else, which is the confinement the owner
 * actually asked for. frame-ancestors stops the dashboard from embedding a
 * site and lending it any of its own context.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' data: blob:",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");

/**
 * Where sites are being served, or nothing if they are not.
 *
 * Set by the host when it binds the site server. It lives in the environment
 * rather than in the kernel because the port is a property of how this process
 * was started, not of the workspace: the same workspace served on another
 * machine or another port is the same workspace.
 */
export function sitesBaseUrl(): string | undefined {
  const url = process.env.KOS_SITES_URL;
  return url && url.trim() ? url.replace(/\/+$/, "") : undefined;
}

export interface Site {
  /** Folder name, and the second path segment of its URL. */
  name: string;
  /** Project it belongs to. */
  project: string;
  /** Workspace-relative path to the folder. */
  path: string;
  /** Whether it has an index.html to land on. */
  hasIndex: boolean;
  modifiedAt: number;
}

/** Directory names directly under a path, ignoring hidden ones. */
function subdirectories(ws: Workspace, relative: string): string[] {
  let dir: string;
  try {
    dir = ws.resolve(relative);
  } catch {
    return [];
  }
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** The sites in one project, in name order. */
export function listSitesFor(ws: Workspace, projectSlug: string): Site[] {
  const base = sitesDirFor(projectSlug);
  return subdirectories(ws, base)
    .map((name) => {
      const path = `${base}/${name}`;
      let modifiedAt = 0;
      try {
        modifiedAt = statSync(ws.resolve(path)).mtimeMs;
      } catch {
        // Vanished between readdir and stat; listing it without a time beats
        // failing the whole list.
      }
      return {
        name,
        project: projectSlug,
        path,
        hasIndex: existsSync(join(ws.resolve(path), "index.html")),
        modifiedAt,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Every site in the workspace, across every project. */
export function listSites(ws: Workspace): Site[] {
  return subdirectories(ws, PROJECTS_DIR)
    .flatMap((slug) => listSitesFor(ws, slug))
    .sort((a, b) => a.project.localeCompare(b.project) || a.name.localeCompare(b.name));
}

export interface ResolvedRequest {
  /** Absolute path of the file to send. */
  file: string;
  contentType: string;
}

/**
 * Work out which file a URL path names, or why it names none.
 *
 * Separate from the server so the interesting part, which is what a crafted
 * path can reach, is testable without binding a port.
 */
export function resolveSiteRequest(
  ws: Workspace,
  urlPath: string,
): ResolvedRequest | { error: "not-found" | "forbidden" } {
  const clean = decodeURIComponent((urlPath.split("?")[0] ?? "/").split("#")[0] ?? "/");
  const rel = clean.replace(/^\/+/, "");
  if (rel === "") return { error: "not-found" };

  // /<project>/<site>/rest. Both segments are needed before anything is
  // resolved, so a request for /projects or /.. cannot land on a directory
  // listing of the workspace.
  const [project, site, ...rest] = rel.split("/");
  if (!project || !site) return { error: "not-found" };

  let abs: string;
  try {
    // The whole path goes through the jail. A request for ../../.env is
    // rejected there rather than pattern-matched here.
    abs = ws.resolve([sitesDirFor(project), site, ...rest].join("/"));
  } catch {
    return { error: "forbidden" };
  }

  let file = abs;
  if (existsSync(file) && statSync(file).isDirectory()) {
    // A folder means its index, which is what a link to /my-site/ expects.
    file = join(file, "index.html");
  }
  if (!existsSync(file) || !statSync(file).isFile()) return { error: "not-found" };

  return {
    file,
    contentType: MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
  };
}

/** The landing page, when someone opens the site server's root. */
function indexPage(sites: Site[]): string {
  const rows = sites.length
    ? sites
        .map(
          (s) =>
            `<li><a href="/${encodeURIComponent(s.project)}/${encodeURIComponent(s.name)}/">` +
            `${escapeHtml(s.project)} / ${escapeHtml(s.name)}</a>` +
            (s.hasIndex ? "" : " <em>no index.html</em>") +
            `</li>`,
        )
        .join("")
    : "<li><em>Nothing here yet. Ask KOS to build something.</em></li>";
  return `<!doctype html><meta charset="utf-8"><title>KOS sites</title>
<style>body{font:16px/1.5 ui-sans-serif,system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;background:#0c0e12;color:#e7ebf3}
a{color:#7c9cff}h1{font-size:1.25rem}li{margin:.35rem 0}em{color:#8b93a7}</style>
<h1>Sites in this workspace</h1><ul>${rows}</ul>`;
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ??
      c,
  );
}

/**
 * Bind the site server.
 *
 * Read-only by construction: it answers GET and HEAD and has no route that
 * writes. The agent changes a site by writing files, which is already guarded
 * where writes are guarded.
 */
export function startSiteServer(
  ws: Workspace,
  port: number,
  host = "127.0.0.1",
): Server {
  const server = createServer((req, res) => {
    const headers = {
      "content-security-policy": CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      // A prototype is edited and reloaded constantly; a cached copy of the
      // page you just asked KOS to change reads as KOS having ignored you.
      "cache-control": "no-store",
    };

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { ...headers, "content-type": "text/plain" });
      res.end("read-only");
      return;
    }

    const urlPath = (req.url ?? "/").split("?")[0] ?? "/";
    if (urlPath === "/" || urlPath === "") {
      const body = indexPage(listSites(ws));
      res.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }

    const found = resolveSiteRequest(ws, urlPath);
    if ("error" in found) {
      res.writeHead(found.error === "forbidden" ? 403 : 404, {
        ...headers,
        "content-type": "text/plain; charset=utf-8",
      });
      res.end(found.error === "forbidden" ? "outside the workspace" : "not found");
      return;
    }

    res.writeHead(200, { ...headers, "content-type": found.contentType });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(found.file).pipe(res);
  });

  server.listen(port, host);
  return server;
}
