import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { guested } from "../kernel/caller.js";
import { ModuleLoader, toolRegistryContext } from "../modules/loader.js";
import { ApprovalQueue } from "../ops/approvals.js";
import { RunsLog } from "../ops/runs.js";
import { SpendStore } from "../ops/spend.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Workspace } from "../store/workspace.js";
import { createStatusModule, LOG_TOOL, logLines, tailOf } from "./status.js";

describe("reading KOS's own log", () => {
  it("gives the last lines, or the last that match, numbered", () => {
    const log = ["boot", "cron: ran 7", "SIGSEGV in worker", "cron: ran 8", "idle", ""].join("\n");
    expect(logLines(log, { lines: 2 })).toEqual(["4: cron: ran 8", "5: idle"]);
    expect(logLines(log, { match: "sigsegv|RAN 8" })).toEqual(["3: SIGSEGV in worker", "4: cron: ran 8"]);
    expect(logLines(log, { match: "nothing" })).toEqual([]);
    expect(logLines(`${"x".repeat(1000)}\n`, {})[0]!.length).toBeLessThan(420);
  });

  it("scrubs what looks like a secret, and gives back a bounded amount", () => {
    const shown = logLines("auth with sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH\n", {}).join("\n");
    expect(shown).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    const many = Array.from({ length: 400 }, (_, i) => `${i} ${"y".repeat(390)}`).join("\n");
    expect(logLines(many, { lines: 400 }).join("\n").length).toBeLessThanOrEqual(24_000);
  });

  it("reads only the end of a long log, from its first whole line", () => {
    const dir = mkdtempSync(join(tmpdir(), "kos-tail-"));
    try {
      const path = join(dir, "daemon.log");
      writeFileSync(path, `${"a".repeat(50)}\nkept line\nlast line\n`);
      expect(tailOf(path, 15)).toBe("last line\n");
      expect(tailOf(path)).toContain("kept line");
      expect(tailOf(join(dir, "none.log"))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("the tool", () => {
    let root: string;
    let ws: Workspace;
    let registry: ToolRegistry;
    let project: string | undefined;

    beforeEach(async () => {
      root = mkdtempSync(join(tmpdir(), "kos-log-"));
      ws = Workspace.open(root);
      mkdirSync(join(root, ".kos"), { recursive: true });
      writeFileSync(join(root, ".kos", "daemon.log"), "boot\ncron: ran 62\n");
      registry = new ToolRegistry();
      const ctx = toolRegistryContext(registry, { workspace: ws, db: ws.db, secrets: new SecretsRegistry(), callerProject: () => project });
      await new ModuleLoader(ctx).load([createStatusModule({ runs: new RunsLog(ws.db), approvals: new ApprovalQueue(ws.db), spend: new SpendStore(ws.db), rates: () => ({}), jobName: () => undefined })]);
    });

    afterEach(() => {
      ws.close();
      rmSync(root, { recursive: true, force: true });
    });

    it("is safe for Maintenance, and refused to other chats and guests", async () => {
      project = "maintenance";
      expect(registry.classify(LOG_TOOL, {}).tier).toBe("safe");
      expect(await registry.refusal(LOG_TOOL, {})).toBeUndefined();
      expect((await registry.execute(LOG_TOOL, { match: "ran" })).content).toBe("2: cron: ran 62");
      expect(await guested.run({ project: "maintenance", chat: "room" }, () => registry.refusal(LOG_TOOL, {}))).toMatch(/guest/);
      project = "school";
      expect(await registry.refusal(LOG_TOOL, {})).toMatch(/Maintenance/);
    });
  });
});
