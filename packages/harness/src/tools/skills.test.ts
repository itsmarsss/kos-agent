import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { ModuleLoader, toolRegistryContext } from "../modules/loader.js";
import { ApprovalQueue } from "../ops/approvals.js";
import { WorkspaceBackup } from "../ops/backup.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { SkillPromoter } from "../skills/promote.js";
import { Workspace } from "../store/workspace.js";
import { createSkillsModule } from "./skills.js";

describe("skills tools", () => {
  let root: string;
  let ws: Workspace;
  let registry: ToolRegistry;
  let approvals: ApprovalQueue;

  function writeSkill(name: string, body: string): string {
    mkdirSync(join(ws.root, "skills"), { recursive: true });
    writeFileSync(join(ws.root, "skills", name), body, "utf8");
    return `skills/${name}`;
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-skills-"));
    ws = Workspace.open(root);
    approvals = new ApprovalQueue(ws.db, new SecretsRegistry());
    const promoter = new SkillPromoter({
      workspaceRoot: ws.root,
      backup: new WorkspaceBackup(ws.root),
      approvals,
    });

    registry = new ToolRegistry();
    const ctx = toolRegistryContext(registry, {
      workspace: ws,
      db: ws.db,
      secrets: new SecretsRegistry(),
    });
    await new ModuleLoader(ctx).load([createSkillsModule(promoter)]);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("confines skills to the skills directory", async () => {
    const res = await registry.execute("skills.test", { entry: "evil.js" });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/skills live under/);
  });

  it("rejects a non-script entry", async () => {
    const res = await registry.execute("skills.test", { entry: "skills/notes.txt" });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/\.js or \.mjs/);
  });

  it("rejects a traversal even under a skills-looking prefix", async () => {
    const res = await registry.execute("skills.test", {
      entry: "skills/../../escape.js",
    });
    expect(res.isError).toBe(true);
  });

  it("runs a passing skill in the sandbox", async () => {
    const entry = writeSkill("ok.js", 'console.log("ran");\n');
    const res = await registry.execute("skills.test", { entry });
    const out = JSON.parse(res.content);
    expect(out.ok).toBe(true);
    expect(out.stdout).toContain("ran");
    expect(out.risk).toBe("safe");
  });

  it("reports a failing skill without throwing", async () => {
    const entry = writeSkill("bad.js", 'throw new Error("boom");\n');
    const out = JSON.parse((await registry.execute("skills.test", { entry })).content);
    expect(out.ok).toBe(false);
    expect(out.stderr).toContain("boom");
  });

  it("promotes a safe skill straight to a commit", async () => {
    const entry = writeSkill("safe.js", 'console.log("nothing risky");\n');
    const out = JSON.parse(
      (await registry.execute("skills.promote", { entry })).content,
    );
    expect(out.status).toBe("promoted");
    expect(approvals.pending()).toHaveLength(0);
  });

  it("queues a risky skill for approval even though the sandbox passed", async () => {
    // The sandbox mocks external effects, so a clean run proves nothing about
    // what this does for real.
    const entry = writeSkill(
      "risky.js",
      'if (process.env.NOPE) { console.log("x"); }\nconsole.log("done");\n',
    );
    const out = JSON.parse(
      (await registry.execute("skills.promote", { entry })).content,
    );
    expect(out.status).toBe("pending_approval");

    const pending = approvals.pending();
    expect(pending).toHaveLength(1);
    // Not skills.promote: approving re-executes the queued tool, and promote
    // would re-assess and re-queue forever.
    expect(pending[0]?.tool).toBe("skills.commit");
    expect(pending[0]?.reason).toMatch(/credentials or environment/);
  });

  it("rejects a skill whose sandbox run fails, before any risk question", async () => {
    const entry = writeSkill("fails.js", 'process.exit(3);\n');
    const out = JSON.parse(
      (await registry.execute("skills.promote", { entry })).content,
    );
    expect(out.status).toBe("rejected");
    expect(approvals.pending()).toHaveLength(0);
  });

  it("lists skills with their risk verdicts", async () => {
    writeSkill("a.js", 'console.log(1);\n');
    writeSkill("b.js", 'fetch("https://example.com");\n');
    const list = JSON.parse((await registry.execute("skills.list", {})).content);
    expect(list).toHaveLength(2);
    expect(list.find((s: { entry: string }) => s.entry.endsWith("a.js")).risky).toBe(false);
    expect(list.find((s: { entry: string }) => s.entry.endsWith("b.js")).risky).toBe(true);
  });

  it("returns an empty list when no skills exist", async () => {
    expect(JSON.parse((await registry.execute("skills.list", {})).content)).toEqual([]);
  });

  it("classifies test, promote and list as safe, run and commit as risky", () => {
    expect(registry.classify("skills.test", {}).tier).toBe("safe");
    expect(registry.classify("skills.promote", {}).tier).toBe("safe");
    expect(registry.classify("skills.list", {}).tier).toBe("safe");
    // Live execution and the commit step are never safe, whatever the source says.
    expect(registry.classify("skills.run", {}).tier).toBe("risky");
    expect(registry.classify("skills.commit", {}).tier).toBe("risky");
  });
});
