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
import { createStatusModule, LOG_TOOL, logLines } from "./status.js";

describe("reading KOS's own log", () => {
  it("gives the last lines, or the last that match, numbered", () => {
    const log = ["boot", "cron: ran 7", "SIGSEGV in worker", "cron: ran 8", "idle", ""].join("\n");
    expect(logLines(log, { lines: 2 })).toEqual(["4: cron: ran 8", "5: idle"]);
    expect(logLines(log, { match: "sigsegv|RAN 8" })).toEqual(["3: SIGSEGV in worker", "4: cron: ran 8"]);
    expect(logLines(log, { match: "nothing" })).toEqual([]);
    expect(logLines(`${"x".repeat(1000)}\n`, {})[0]!.length).toBeLessThan(420);
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
