import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Inference } from "../agent/loop.js";
import { DaemonStore } from "../daemons/store.js";
import { MODULES_KEY, parseModuleSettings, runnableModules } from "../modules/workspace.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { SettingsStore } from "../store/settings.js";
import { Workspace } from "../store/workspace.js";
import type { NotifyPayload } from "../tools/notify.js";
import { Kernel } from "./kernel.js";

const quiet: Inference = {
  async generate() {
    return { content: [{ type: "text", text: "done" }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" };
  },
};

describe("the first boot that pins approved code", () => {
  let root: string;
  let kernel: Kernel | undefined;

  afterEach(() => {
    kernel?.close();
    kernel = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  const boot = (told: string[]): Promise<Kernel> =>
    Kernel.boot({
      rootDir: root,
      secrets: new SecretsRegistry(),
      inference: quiet,
      notify: async (payload: NotifyPayload) => void told.push(payload.text),
      profileOverrides: { name: "Kenny", timezone: "UTC" },
    });

  it("keeps what was on running, pinned as it was, says so once, and audits it", async () => {
    root = mkdtempSync(join(tmpdir(), "kos-adopt-"));
    // A workspace from before pins: a blueprint module switched on, a daemon approved.
    const ws = Workspace.open(root);
    mkdirSync(join(root, "modules", "budget"), { recursive: true });
    writeFileSync(join(root, "modules", "budget", "module.json"), JSON.stringify({ name: "budget", description: "A budget", blueprint: { type: "budget", schema: [], pages: [], jobs: [] } }));
    mkdirSync(join(root, "projects", "app"), { recursive: true });
    writeFileSync(join(root, "projects", "app", "server.js"), "setInterval(() => {}, 1000);");
    new SettingsStore(ws.db).set(MODULES_KEY, { enabled: ["budget"], disabledBuiltins: [] });
    new DaemonStore(ws.db).create({ project: "app", name: "api", runtime: "node", entry: "projects/app/server.js" });
    ws.close();

    const told: string[] = [];
    kernel = await boot(told);
    const settings = parseModuleSettings(kernel.settings.get(MODULES_KEY));
    expect(runnableModules(kernel.workspace, settings)).toEqual(["budget"]);
    expect(kernel.daemons.list()[0]?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    const said = told.filter((t) => t.includes("pins the code you approve"));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("module budget");
    expect(said[0]).toContain("daemon app/api");
    const audited = kernel.workspace.db.prepare("SELECT args FROM audit_log WHERE tool = 'kos.pin'").all() as { args: string }[];
    expect(audited.map((a) => a.args).sort()).toEqual(['{"adopted":"daemon app/api"}', '{"adopted":"module budget"}']);
    kernel.close();

    // Once: a later boot adopts nothing, and says nothing.
    const again: string[] = [];
    kernel = await boot(again);
    expect(again.filter((t) => t.includes("pins the code you approve"))).toEqual([]);
  });
});
