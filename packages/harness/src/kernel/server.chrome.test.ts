import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findChrome } from "@kos/browser";

import type { Inference } from "../agent/loop.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Kernel } from "./kernel.js";
import { handleApiRequest } from "./server.js";

/**
 * The owner's export route drawn on the check's own Chrome, through the
 * kernel as the host runs it. Skipped without Chrome.
 */

const stub: Inference = {
  async generate() {
    return { content: [{ type: "text", text: "hi" }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" };
  },
};

describe.skipIf(!findChrome(undefined))("the owner's exports with a Chrome on the machine", () => {
  let kernel: Kernel;
  let root: string;
  const tmp = process.env.TMPDIR;
  const builtBefore = process.env.KOS_UI_DIST;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-api-chrome-"));
    // The dashboard's build of the frame, as a test's own: the kit's sheet, tokens and a stand-in for each runtime.
    const pageLib = join(root, "ui-dist", "page-lib");
    mkdirSync(join(pageLib, "fonts"), { recursive: true });
    writeFileSync(join(pageLib, "frame.css"), "body{margin:0}");
    writeFileSync(join(pageLib, "tokens.json"), JSON.stringify({ dark: { "--bg": "#0c0e12" }, light: { "--bg": "#f4f5f8" } }));
    for (const runtime of ["kos-doc", "kos-deck", "kos-sheet"]) writeFileSync(join(pageLib, `${runtime}.js`), `/* ${runtime} */`);
    process.env.KOS_UI_DIST = join(root, "ui-dist");
    // The check's Chrome keeps its profile, and sweeps left-behind ones, in a temp folder of the test's own.
    process.env.TMPDIR = root;
    // Its own browser for the web is never started here; the check's Chrome is found as on any host.
    kernel = await Kernel.boot({ rootDir: root, secrets: new SecretsRegistry(), inference: stub, chrome: { port: 1 } });
    kernel.manifest.createProject({ name: "Shelf", type: "tracker" });
    kernel.migrator.migrate("shelf", { op: "create_table", table: "books", columns: [{ name: "id", type: "INTEGER", primaryKey: true }, { name: "title", type: "TEXT" }] });
    kernel.workspace.db.exec("INSERT INTO shelf_books (title) VALUES ('Dune')");
    kernel.pages.writeHtml("shelf", { id: "reader", title: "Reader", html: '<h1>Reader</h1><p id="out">-</p><script>kos.query("SELECT title FROM shelf_books").then(function(r){out.textContent=r.rows[0].title})</script>' });
  });

  afterEach(async () => {
    // The check's Chrome stopped and its profile deleted before the folder holding it goes.
    await kernel.closeBrowser();
    kernel.close();
    if (tmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = tmp;
    if (builtBefore === undefined) delete process.env.KOS_UI_DIST;
    else process.env.KOS_UI_DIST = builtBefore;
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("draws a page that reads, and freezes what it read into its HTML", async () => {
    const res = await handleApiRequest(kernel, { method: "GET", path: "/api/artifacts/reader/export", url: "/api/artifacts/reader/export?format=html" });
    expect(res.status, JSON.stringify(res.status === 200 ? null : res.body)).toBe(200);
    expect((res.body as Buffer).toString("utf8")).toContain("&quot;rows&quot;:[{&quot;title&quot;:&quot;Dune&quot;}]");
  }, 60_000);
});
