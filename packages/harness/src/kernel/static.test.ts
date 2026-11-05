import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Inference } from "../agent/loop.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Kernel } from "./kernel.js";
import { createDashboardServer } from "./server.js";

const stub: Inference = {
  async generate() {
    return { content: [{ type: "text", text: "hi" }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" };
  },
};

/** The dashboard's files: the app for any route, but never the app in place of a page library. */
describe("the dashboard's static files", () => {
  let root: string;
  let kernel: Kernel;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-static-"));
    const ui = join(root, "ui");
    mkdirSync(join(ui, "page-lib"), { recursive: true });
    writeFileSync(join(ui, "index.html"), "<!doctype html><title>KOS</title>");
    writeFileSync(join(ui, "page-lib", "charts.js"), "window.KosCharts = {};");
    kernel = await Kernel.boot({ rootDir: join(root, "ws"), secrets: new SecretsRegistry(), inference: stub, chrome: { port: 1, exists: () => false } });
    server = createDashboardServer(kernel, { staticDir: ui });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("serves a page library as a script, and a missing one as not found", async () => {
    const lib = await fetch(`${base}/page-lib/charts.js`);
    expect(lib.status).toBe(200);
    expect(lib.headers.get("content-type")).toMatch(/javascript/);
    const missing = await fetch(`${base}/page-lib/react.js`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toContain("<title>KOS</title>");
    // Any other route is still the app.
    expect(await (await fetch(`${base}/projects/x`)).text()).toContain("<title>KOS</title>");
  });
});
