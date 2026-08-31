import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { listSites, resolveSiteRequest, startSiteServer } from "./server.js";

describe("serving what the agent built", () => {
  let root: string;
  let ws: Workspace;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-sites-"));
    ws = Workspace.open(root);
    mkdirSync(join(ws.root, "sites", "tracker", "assets"), { recursive: true });
    writeFileSync(join(ws.root, "sites", "tracker", "index.html"), "<h1>Tracker</h1>");
    writeFileSync(join(ws.root, "sites", "tracker", "assets", "app.js"), "console.log(1)");
    mkdirSync(join(ws.root, "sites", "draft"), { recursive: true });
    // Something private, in the workspace but not in sites/.
    writeFileSync(join(ws.root, "kos.db"), "secrets");
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  describe("listing", () => {
    it("lists site folders, noting which have somewhere to land", () => {
      const sites = listSites(ws);
      expect(sites.map((s) => s.name)).toEqual(["draft", "tracker"]);
      expect(sites.find((s) => s.name === "tracker")?.hasIndex).toBe(true);
      expect(sites.find((s) => s.name === "draft")?.hasIndex).toBe(false);
    });

    it("is empty rather than broken when nothing has been built", () => {
      const bare = mkdtempSync(join(tmpdir(), "kos-bare-"));
      const bareWs = Workspace.open(bare);
      expect(listSites(bareWs)).toEqual([]);
      bareWs.close();
      rmSync(bare, { recursive: true, force: true });
    });
  });

  describe("what a url can reach", () => {
    it("serves a file inside a site, typed by extension", () => {
      const found = resolveSiteRequest(ws, "/tracker/assets/app.js");
      expect("error" in found).toBe(false);
      if ("error" in found) return;
      expect(found.contentType).toMatch(/javascript/);
    });

    it("lands a bare site url on its index", () => {
      const found = resolveSiteRequest(ws, "/tracker/");
      expect("error" in found).toBe(false);
      if ("error" in found) return;
      expect(found.file.endsWith("index.html")).toBe(true);
    });

    /*
     * The point of the whole feature: everything under sites/ is reachable and
     * nothing above it is. The database sits one level up from a site, so a
     * traversal that worked would hand out the workspace itself.
     */
    it("cannot climb out of sites/ into the workspace", () => {
      for (const attempt of [
        "/../kos.db",
        "/tracker/../../kos.db",
        "/tracker/../../../etc/passwd",
        "/%2e%2e/kos.db",
        "/tracker/%2e%2e/%2e%2e/kos.db",
      ]) {
        const found = resolveSiteRequest(ws, attempt);
        expect("error" in found, `${attempt} was served`).toBe(true);
      }
    });

    it("does not follow a symlink pointed out of the workspace", () => {
      const outside = mkdtempSync(join(tmpdir(), "kos-outside-"));
      writeFileSync(join(outside, "secret.txt"), "not yours");
      symlinkSync(join(outside, "secret.txt"), join(ws.root, "sites", "tracker", "leak.txt"));
      const found = resolveSiteRequest(ws, "/tracker/leak.txt");
      expect("error" in found).toBe(true);
      rmSync(outside, { recursive: true, force: true });
    });

    it("says not found for a missing file", () => {
      const found = resolveSiteRequest(ws, "/tracker/nope.html");
      expect(found).toEqual({ error: "not-found" });
    });
  });

  describe("over http", () => {
    let server: Server;
    let base: string;

    beforeEach(async () => {
      server = startSiteServer(ws, 0);
      await new Promise((r) => server.once("listening", r));
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      base = `http://127.0.0.1:${port}`;
    });

    afterEach(() => {
      server.close();
    });

    it("serves a site's page", async () => {
      const res = await fetch(`${base}/tracker/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Tracker");
    });

    /*
     * A site is agent-written markup with scripts in it. These headers are what
     * stops it phoning the workspace's contents out to someone else, so they
     * are worth asserting rather than trusting.
     */
    it("forbids a page from reaching anything off the machine", async () => {
      const res = await fetch(`${base}/tracker/`);
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("connect-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    });

    it("refuses a traversal over the wire too", async () => {
      const res = await fetch(`${base}/tracker/../../kos.db`, { redirect: "manual" });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await res.text()).not.toContain("secrets");
    });

    it("is read-only: a write method is refused", async () => {
      const res = await fetch(`${base}/tracker/index.html`, {
        method: "POST",
        body: "x",
      });
      expect(res.status).toBe(405);
    });

    it("lists the sites at the root", async () => {
      const res = await fetch(`${base}/`);
      const body = await res.text();
      expect(body).toContain("tracker");
      expect(body).toContain("draft");
    });
  });
});
