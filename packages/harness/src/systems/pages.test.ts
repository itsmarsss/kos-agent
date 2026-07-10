import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { ProjectManifest } from "./manifest.js";
import { PageStore } from "./pages.js";
import { runDisplayQuery } from "./display.js";

describe("PageStore", () => {
  let root: string;
  let ws: Workspace;
  let pages: PageStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-pages-"));
    ws = Workspace.open(root);
    const manifest = new ProjectManifest(ws.db);
    manifest.createProject({ name: "Demo", type: "tracker" });
    pages = new PageStore(ws.db, ws, manifest);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("writes, lists, and loads a valid page", () => {
    const rec = pages.write("demo", {
      id: "overview",
      title: "Overview",
      widgets: [
        {
          type: "stat",
          label: "N",
          query: "SELECT 1 AS n",
        },
      ],
    });
    expect(rec.id).toBe("overview");
    expect(pages.list("demo")).toHaveLength(1);
    const got = pages.get("overview");
    expect(got?.spec.title).toBe("Overview");
  });

  it("rejects invalid specs", () => {
    expect(() =>
      pages.write("demo", {
        id: "!!!",
        title: "x",
        widgets: [{ type: "stat", label: "n", query: "DELETE FROM x" }],
      }),
    ).toThrow(/invalid page/);
  });
});

describe("runDisplayQuery", () => {
  let root: string;
  let ws: Workspace;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-dq-"));
    ws = Workspace.open(root);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("runs a select and rejects writes", () => {
    const res = runDisplayQuery(ws.db, "SELECT 1 AS n");
    expect(res.rows[0]).toEqual({ n: 1 });
    expect(() => runDisplayQuery(ws.db, "DELETE FROM x")).toThrow(/read-only/);
  });
});
