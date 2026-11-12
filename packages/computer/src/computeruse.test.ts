import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase, type ModuleContext, type ModuleServices } from "@kos/harness";
import { drawingOf, lookOf } from "@kos/shared";
import { describe, expect, it } from "vitest";

import { createComputerUse } from "./computeruse.js";
import { PREFIX } from "./routes.js";

describe("computer use with this computer's secret unreadable", () => {
  it("switches on as ever, says why once, and leaves the file as it was", async () => {
    const dir = mkdtempSync(join(tmpdir(), "computeruse-test-"));
    const localKeyPath = join(dir, "device-local.key");
    writeFileSync(localKeyPath, "not a key");
    const logged: string[] = [];
    const panel = { current: () => undefined, events: () => [] };
    const use = createComputerUse({
      hostKeyPath: join(dir, "device-host.key"),
      localKeyPath,
      caller: () => undefined,
      titleOf: (id) => id,
      halted: () => false,
      face: () => drawingOf(lookOf("kos")),
      theme: () => ({ mode: "system" }),
      panels: { chrome: panel, mac: panel, phone: panel },
      updates: { expected: () => undefined, log: (line) => logged.push(line) },
    });
    const ctx = { registerTool: () => undefined, unregisterTool: () => undefined, services: { db: openDatabase(":memory:") } as unknown as ModuleServices } as unknown as ModuleContext;
    await use.module.activate(ctx);
    expect(await use.routes.handle({ method: "GET", path: PREFIX })).toMatchObject({ status: 200, body: { devices: [] } });
    expect(logged).toEqual([expect.stringMatching(new RegExp(`^devices: KOS can't tell this Mac is its own: remove ${localKeyPath} and KOS makes another \\(`))]);
    expect(readFileSync(localKeyPath, "utf8")).toBe("not a key");
    await use.module.deactivate?.();
    await use.close();
  });
});
