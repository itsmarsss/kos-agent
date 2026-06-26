import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { snapshotDatabase } from "./snapshot.js";

describe("snapshotDatabase", () => {
  let root: string;
  let ws: Workspace;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-snap-"));
    ws = Workspace.open(root);
    ws.db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    ws.db.prepare("INSERT INTO t (id) VALUES (1)").run();
    ws.close();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("copies the data into a new file", async () => {
    const dest = join(root, "copy.sqlite");
    await snapshotDatabase(join(root, "kos.sqlite"), dest);
    const copy = new Database(dest, { readonly: true });
    const count = copy.prepare("SELECT COUNT(*) AS n FROM t").get() as {
      n: number;
    };
    copy.close();
    expect(count.n).toBe(1);
  });

  it("isolates the copy from the source", async () => {
    const dest = join(root, "copy.sqlite");
    await snapshotDatabase(join(root, "kos.sqlite"), dest);

    const copy = new Database(dest);
    copy.prepare("INSERT INTO t (id) VALUES (2)").run();
    copy.close();

    const src = new Database(join(root, "kos.sqlite"), { readonly: true });
    const count = src.prepare("SELECT COUNT(*) AS n FROM t").get() as {
      n: number;
    };
    src.close();
    expect(count.n).toBe(1); // source unchanged by writes to the copy
  });
});
