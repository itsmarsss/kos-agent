import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { nextPort, PORT_RANGE } from "../tools/daemons.js";
import { routeTo } from "./proxy.js";
import { DaemonStore } from "./store.js";

describe("DaemonStore", () => {
  let root: string;
  let ws: Workspace;
  let store: DaemonStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-daemons-"));
    ws = Workspace.open(root);
    store = new DaemonStore(ws.db);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("registers one and finds it by project and name", () => {
    const made = store.create({
      project: "app",
      name: "api",
      runtime: "node",
      entry: "projects/app/server.js",
      port: 4400,
    });
    expect(store.find("app", "api")?.id).toBe(made.id);
    expect(made.enabled).toBe(true);
  });

  it("refuses two daemons with the same name in one project", () => {
    store.create({ project: "app", name: "api", runtime: "node", entry: "a.js" });
    expect(() =>
      store.create({ project: "app", name: "api", runtime: "node", entry: "b.js" }),
    ).toThrow();
  });

  it("keeps whether it should be running across a restart", () => {
    const made = store.create({
      project: "app",
      name: "api",
      runtime: "node",
      entry: "a.js",
    });
    store.setEnabled(made.id, false);
    // A fresh store is the same thing a restarted host sees.
    expect(new DaemonStore(ws.db).get(made.id)?.enabled).toBe(false);
  });

  it("reports the ports already spoken for", () => {
    store.create({ project: "a", name: "x", runtime: "node", entry: "a.js", port: 4400 });
    store.create({ project: "b", name: "y", runtime: "node", entry: "b.js", port: null });
    expect(store.takenPorts()).toEqual(new Set([4400]));
  });
});

describe("port allocation", () => {
  it("gives out the lowest free port", () => {
    expect(nextPort(new Set())).toBe(PORT_RANGE.first);
    expect(nextPort(new Set([PORT_RANGE.first]))).toBe(PORT_RANGE.first + 1);
  });

  it("says so rather than colliding when the band is full", () => {
    const all = new Set<number>();
    for (let p = PORT_RANGE.first; p <= PORT_RANGE.last; p++) all.add(p);
    expect(() => nextPort(all)).toThrow(/no ports left/);
  });
});

describe("daemon proxy routing", () => {
  const lookup = (project: string, name: string): { port: number | null } | undefined =>
    project === "app" && name === "api"
      ? { port: 4400 }
      : project === "app" && name === "worker"
        ? { port: null }
        : undefined;

  it("sends the rest of the path to the daemon", () => {
    expect(routeTo("/apps/app/api/items/3", lookup)).toEqual({
      port: 4400,
      path: "/items/3",
    });
  });

  it("keeps the query string", () => {
    expect(routeTo("/apps/app/api/search?q=hat", lookup)?.path).toBe("/search?q=hat");
  });

  it("asks for the root when there is nothing after the name", () => {
    expect(routeTo("/apps/app/api/", lookup)?.path).toBe("/");
  });

  it("is not interested in anything else the server serves", () => {
    expect(routeTo("/api/status", lookup)).toBeUndefined();
    expect(routeTo("/index.html", lookup)).toBeUndefined();
    expect(routeTo("/apps/app", lookup)).toBeUndefined();
  });

  it("has nowhere to send a daemon that listens on nothing", () => {
    expect(routeTo("/apps/app/worker/", lookup)).toBeUndefined();
  });
});
