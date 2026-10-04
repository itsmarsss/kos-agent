import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { toolRegistryContext } from "../modules/loader.js";
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
  let disabled: string[];

  /** A skill on disk, the way skills.create would leave it. */
  function skill(name: string, kind: "script" | "prompt", body: string, extra: Record<string, unknown> = {}): void {
    const dir = join(ws.root, "skills", name);
    mkdirSync(dir, { recursive: true });
    const file = kind === "script" ? "run.mjs" : "SKILL.md";
    writeFileSync(
      join(dir, "skill.json"),
      JSON.stringify({ name, description: `${name} skill`, kind, ...(kind === "script" ? { entry: file } : {}), ...extra }),
      "utf8",
    );
    writeFileSync(join(dir, file), body, "utf8");
  }

  async function call(name: string, input: Record<string, unknown> = {}) {
    const res = await registry.execute(name, input);
    // skills.use hands back the instructions themselves, not JSON.
    let json: Record<string, unknown> | undefined;
    if (!res.isError) {
      try { json = JSON.parse(res.content) as Record<string, unknown>; } catch { json = undefined; }
    }
    return { ...res, json };
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-skills-"));
    ws = Workspace.open(root);
    approvals = new ApprovalQueue(ws.db, new SecretsRegistry());
    const promoter = new SkillPromoter({ workspaceRoot: ws.root, backup: new WorkspaceBackup(ws.root), approvals });
    registry = new ToolRegistry();
    disabled = [];
    const ctx = toolRegistryContext(registry, { workspace: ws, db: ws.db, secrets: new SecretsRegistry() });
    await createSkillsModule({ promoter, disabled: () => disabled }).activate(ctx);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("lists skills with kind, state and a verdict for scripts", async () => {
    skill("hello", "script", "console.log('hi')");
    skill("review", "prompt", "Read the diff first.");
    disabled = ["review"];
    const { json } = await call("skills.list");
    expect(json!["skills"]).toEqual([
      expect.objectContaining({ name: "hello", kind: "script", enabled: true, risk: "safe" }),
      expect.objectContaining({ name: "review", kind: "prompt", enabled: false }),
    ]);
  });

  it("makes a prompt skill the model can then read", async () => {
    const made = await call("skills.create", {
      name: "pr-review",
      description: "How to review a pull request",
      kind: "prompt",
      content: "Read the diff. Then the tests.",
    });
    expect(made.json).toMatchObject({ created: "pr-review", kind: "prompt" });
    const used = await call("skills.use", { name: "pr-review" });
    expect(used.content).toBe("Read the diff. Then the tests.\n");
  });

  it("makes a script skill that the sandbox can test", async () => {
    await call("skills.create", { name: "say", description: "Says hi", kind: "script", content: "console.log('hi')" });
    const tested = await call("skills.test", { name: "say" });
    expect(tested.json).toMatchObject({ ok: true, risk: "safe" });
    expect(String(tested.json!["stdout"])).toContain("hi");
  });

  it("refuses to make a skill over one that exists, or with a bad name", async () => {
    skill("taken", "prompt", "x");
    expect((await call("skills.create", { name: "taken", description: "d", kind: "prompt", content: "y" })).isError).toBe(true);
    expect((await call("skills.create", { name: "../out", description: "d", kind: "prompt", content: "y" })).isError).toBe(true);
    expect((await call("skills.create", { name: "Bad Name", description: "d", kind: "prompt", content: "y" })).isError).toBe(true);
  });

  it("never reaches a file outside the skill's own directory", async () => {
    /*
     * The name is the only thing the model supplies, and the pattern it must
     * match has no separators. A manifest pointing outside its directory is
     * rejected when read. So there is no input that resolves elsewhere.
     */
    const dir = join(ws.root, "skills", "sneaky");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "skill.json"), JSON.stringify({ name: "sneaky", description: "d", kind: "script", entry: "../../profile.json" }), "utf8");
    expect((await call("skills.test", { name: "sneaky" })).content).toMatch(/not usable/);
    expect((await call("skills.use", { name: "../x" })).content).toMatch(/not a skill name/);
  });

  it("will not use or run a skill the owner switched off", async () => {
    skill("review", "prompt", "x");
    skill("hello", "script", "console.log('hi')");
    disabled = ["review", "hello"];
    expect((await call("skills.use", { name: "review" })).content).toMatch(/switched off/);
    expect((await call("skills.run", { name: "hello" })).content).toMatch(/switched off/);
    // Testing and listing still work: off is not deleted.
    expect((await call("skills.test", { name: "hello" })).isError).toBe(false);
  });

  it("tells a script from a prompt, and says what to do instead", async () => {
    skill("review", "prompt", "x");
    skill("hello", "script", "console.log('hi')");
    expect((await call("skills.run", { name: "review" })).content).toMatch(/prompt skill.*skills\.use/);
    expect((await call("skills.use", { name: "hello" })).content).toMatch(/script skill.*skills\.run/);
  });

  it("reports a failing script without throwing", async () => {
    skill("bad", "script", "process.exit(3)");
    const { json } = await call("skills.test", { name: "bad" });
    expect(json).toMatchObject({ ok: false, exitCode: 3 });
  });

  it("promotes a safe script straight to a commit", async () => {
    skill("hello", "script", "console.log('hi')");
    const { json } = await call("skills.promote", { name: "hello" });
    expect(json!["status"]).toBe("promoted");
  });

  it("queues a risky script for approval even though the sandbox passed", async () => {
    skill("danger", "script", "import fs from 'node:fs'; fs.rmSync('x', { force: true })");
    const { json } = await call("skills.promote", { name: "danger" });
    expect(json!["status"]).toBe("pending_approval");
    expect(approvals.pending()).toHaveLength(1);
  });

  it("classifies create, use, test, promote and list as safe; run and commit as risky", () => {
    for (const safe of ["skills.list", "skills.create", "skills.use", "skills.test", "skills.promote"]) {
      expect(registry.classify(safe, {}).tier).toBe("safe");
    }
    for (const risky of ["skills.run", "skills.commit"]) {
      expect(registry.classify(risky, {}).tier).toBe("risky");
    }
  });
});
