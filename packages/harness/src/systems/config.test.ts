import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { InstanceConfig } from "./config.js";

describe("InstanceConfig", () => {
  let root: string;
  let ws: Workspace;
  let config: InstanceConfig;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-cfg-"));
    ws = Workspace.open(root);
    config = new InstanceConfig(ws.db);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("sets and gets typed config per instance", () => {
    config.set("budget_household", "currency", "USD");
    config.set("budget_household", "categories", ["food", "rent"]);
    expect(config.get<string>("budget_household", "currency")).toBe("USD");
    expect(config.get<string[]>("budget_household", "categories")).toEqual([
      "food",
      "rent",
    ]);
  });

  it("upserts an existing key", () => {
    config.set("p", "limit", 100);
    config.set("p", "limit", 200);
    expect(config.get("p", "limit")).toBe(200);
  });

  it("scopes config to its instance", () => {
    config.set("a", "k", 1);
    config.set("b", "k", 2);
    expect(config.all("a")).toEqual({ k: 1 });
    expect(config.all("b")).toEqual({ k: 2 });
  });

  it("deletes a key", () => {
    config.set("p", "k", 1);
    expect(config.delete("p", "k")).toBe(true);
    expect(config.get("p", "k")).toBeUndefined();
  });
});
