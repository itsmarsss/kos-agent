import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { toolRegistryContext } from "../modules/loader.js";
import { GuardedTools } from "../kernel/guarded.js";
import { ApprovalQueue } from "../ops/approvals.js";
import { AuditLog } from "../ops/audit.js";
import { PermissionStore } from "../ops/permissions.js";
import { WorkspaceBackup } from "../ops/backup.js";
import { runSandbox, type SkillJail } from "../sandbox/runner.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { readSkills, skillHash } from "../skills/manifest.js";
import { SkillPromoter } from "../skills/promote.js";
import { Workspace } from "../store/workspace.js";
import { createSkillsModule } from "./skills.js";

describe("skills tools", () => {
  let root: string;
  let ws: Workspace;
  let registry: ToolRegistry;
  let approvals: ApprovalQueue;
  let disabled: string[];
  let promoted: Record<string, string>;
  /** The platform's sandbox on macOS; elsewhere these tests stand in for the container, which is the jail there. */
  let jail: SkillJail;

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
    // Its sandbox in the same jail as the tools', so the container stands in for it off macOS too.
    const promoter = new SkillPromoter({ workspaceRoot: ws.root, backup: new WorkspaceBackup(ws.root), runSandbox: (o) => runSandbox({ ...o, jail }) });
    registry = new ToolRegistry();
    disabled = [];
    promoted = {};
    jail = { contained: process.platform !== "darwin" };
    const ctx = toolRegistryContext(registry, { workspace: ws, db: ws.db, secrets: new SecretsRegistry() });
    await createSkillsModule({ promoter, disabled: () => disabled, promoted: () => promoted, markPromoted: (name, hash) => (promoted[name] = hash), get jail() { return jail; } }).activate(ctx);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("lists skills with kind, state and whether a script is promoted", async () => {
    skill("hello", "script", "console.log('hi')");
    skill("review", "prompt", "Read the diff first.");
    disabled = ["review"];
    const { json } = await call("skills.list");
    expect(json!["skills"]).toEqual([
      expect.objectContaining({ name: "hello", kind: "script", enabled: true, promoted: false }),
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
    expect(tested.json).toMatchObject({ ok: true });
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

  /** What a skill's files hash to now. */
  const hashOf = (name: string): string => skillHash(ws, readSkills(ws).skills.find((s) => s.manifest.name === name)!);

  it("runs a promoted skill without asking, and asks for one that is not", () => {
    skill("daily", "script", "console.log('hi')");
    expect(registry.classify("skills.run", { name: "daily" })).toMatchObject({ tier: "risky", reason: "runs a skill that was not promoted" });
    promoted["daily"] = hashOf("daily");
    expect(registry.classify("skills.run", { name: "daily" }).tier).toBe("safe");
    expect(registry.classify("skills.run", { name: "other" }).tier).toBe("risky");
    // Switched off, it asks again rather than running on the strength of an old yes.
    disabled.push("daily");
    expect(registry.classify("skills.run", { name: "daily" }).tier).toBe("risky");
  });

  it("holds a learned yes to a skill for its code: unchanged it runs unasked, edited it asks", async () => {
    skill("daily", "script", "console.log('hi')");
    const permissions = new PermissionStore(ws.db);
    const stamped = await registry.stamp("skills.run", { name: "daily", hash: "made-up" });
    expect(stamped).toEqual({ name: "daily", hash: hashOf("daily") });
    expect(permissions.holdBurst("c1", "skills.run", stamped)).toBe(true);
    const tools = new GuardedTools({ registry, secrets: new SecretsRegistry(), audit: new AuditLog(ws.db), approvals, conversationId: "c1", permissions, waitForApproval: false });
    expect((await tools.execute("skills.run", { name: "daily" })).content).not.toMatch(/^Queued for approval/);
    expect(approvals.pending()).toHaveLength(0);
    skill("daily", "script", "console.log('changed by what a turn read')");
    expect((await tools.execute("skills.run", { name: "daily" })).content).toMatch(/^Queued for approval/);
  });

  it("refuses to run a skill whose code changed after the call was judged", async () => {
    skill("daily", "script", "console.log('hi')");
    const stamped = await registry.stamp("skills.run", { name: "daily" });
    skill("daily", "script", "console.log('edited')");
    expect((await call("skills.run", stamped)).content).toMatch(/changed after this run was judged/);
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

  /** A keeping tool asked through the guarded path, as a chat asks it: the promise settles once the owner decides. */
  async function ask(name: string, tool = "skills.commit") {
    const tools = new GuardedTools({ registry, secrets: new SecretsRegistry(), audit: new AuditLog(ws.db), approvals, conversationId: "c1" });
    const done = tools.execute(tool, { name });
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
    return { done, asked: approvals.pending()[0]! };
  }

  it("promotes nothing without the owner's yes, however plain the script, and asks every time", () => {
    skill("hello", "script", "console.log('hi')");
    for (const tool of ["skills.promote", "skills.commit"]) {
      // Risky and asked every time: no Auto and no remembered decision keeps code to run.
      expect(registry.classify(tool, { name: "hello" })).toMatchObject({ tier: "risky", asksAlways: true });
    }
  });

  it("tests and commits a skill once the owner says yes to its files", async () => {
    skill("hello", "script", "console.log('hi')");
    const { done, asked } = await ask("hello", "skills.promote");
    expect(asked.reason).toBe("tests and keeps hello, code of KOS's own writing, to run without asking from now on");
    expect(JSON.parse(asked.args)).toEqual({ name: "hello", hash: hashOf("hello") });
    approvals.approve(asked.id, "owner", { via: "dashboard" });
    const result = await done;
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/"status":"promoted"/);
    expect(promoted).toEqual({ hello: hashOf("hello") });
    expect(registry.classify("skills.run", { name: "hello" }).tier).toBe("safe");
  });

  it("ties the owner's yes to the script as it was when asked", async () => {
    skill("danger", "script", "import fs from 'node:fs'; fs.rmSync('x', { force: true })");
    const { done, asked } = await ask("danger");
    // The ask carries the hash of what was shown.
    expect(asked.reason).toBe("keeps, untested, danger, code of KOS's own writing, to run without asking from now on");
    expect(JSON.parse(asked.args)).toEqual({ name: "danger", hash: hashOf("danger") });
    writeFileSync(join(ws.root, "skills", "danger", "run.mjs"), "import fs from 'node:fs'; fs.rmSync('/', { recursive: true })", "utf8");
    approvals.approve(asked.id, "owner", { via: "dashboard" });
    const result = await done;
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/changed after the owner was asked/);
    expect(promoted).toEqual({});
    // A hash the model supplies is not the ask's: the harness sets its own.
    expect((await call("skills.commit", { name: "danger", hash: "made-up" })).content).toMatch(/changed after the owner was asked/);
    expect((await call("skills.promote", { name: "danger", hash: "made-up" })).content).toMatch(/changed after the owner was asked/);
  });

  it("asks again once any file in the skill's folder changes, a helper it imports included", async () => {
    skill("lib", "script", "import { hi } from './lib.mjs'; hi();");
    writeFileSync(join(ws.root, "skills", "lib", "lib.mjs"), "export const hi = () => console.log('hi');\n", "utf8");
    promoted["lib"] = hashOf("lib");
    expect(registry.classify("skills.run", { name: "lib" }).tier).toBe("safe");
    writeFileSync(join(ws.root, "skills", "lib", "lib.mjs"), "export const hi = () => console.log('changed');\n", "utf8");
    expect(registry.classify("skills.run", { name: "lib" }).tier).toBe("risky");
    // A new file beside it, in a folder of its own too.
    writeFileSync(join(ws.root, "skills", "lib", "lib.mjs"), "export const hi = () => console.log('hi');\n", "utf8");
    expect(registry.classify("skills.run", { name: "lib" }).tier).toBe("safe");
    mkdirSync(join(ws.root, "skills", "lib", "node_modules"));
    writeFileSync(join(ws.root, "skills", "lib", "node_modules", "x.js"), "", "utf8");
    expect(registry.classify("skills.run", { name: "lib" }).tier).toBe("risky");
  });

  it("never runs unasked a skill holding a link, whose code could be anywhere", () => {
    skill("linked", "script", "import './lib.mjs';");
    const outside = mkdtempSync(join(tmpdir(), "kos-skill-out-"));
    try {
      writeFileSync(join(outside, "lib.mjs"), "", "utf8");
      const before = hashOf("linked");
      symlinkSync(join(outside, "lib.mjs"), join(ws.root, "skills", "linked", "lib.mjs"));
      promoted["linked"] = before;
      expect(registry.classify("skills.run", { name: "linked" }).tier).toBe("risky");
      expect(() => hashOf("linked")).toThrow(/not a plain file/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses to test, promote or run a script where there is no jail, rather than asking", async () => {
    skill("hello", "script", "console.log('hi')");
    jail = { platform: "linux", contained: false, bubblewrap: false };
    for (const tool of ["skills.test", "skills.promote", "skills.commit", "skills.run"]) {
      expect(await registry.refusal(tool, { name: "hello" })).toMatch(/runs only in a jail/);
    }
    promoted["hello"] = hashOf("hello");
    await expect(call("skills.run", { name: "hello" })).resolves.toMatchObject({ isError: true });
  });

  describe.runIf(process.platform === "darwin")("in the macOS jail", () => {
    let home: string;
    let elsewhere: string;
    beforeEach(() => {
      // Real, as a home is: the sandbox matches the path the disk names, /private/var for a temp folder.
      home = realpathSync(mkdtempSync(join(tmpdir(), "kos-skill-home-")));
      elsewhere = mkdtempSync(join(tmpdir(), "kos-skill-else-"));
      writeFileSync(join(home, "id_rsa"), "PRIVATE\n", "utf8");
      jail = { contained: false, homes: [home] };
    });
    afterEach(() => {
      rmSync(home, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    });

    /** A script reporting what it could reach, one line of JSON. */
    const probe = () => `import fs from "node:fs";
const tryDo = (f) => { try { f(); return "yes"; } catch { return "no"; } };
const out = {
  home: tryDo(() => fs.readFileSync(${JSON.stringify(join(home, "id_rsa"))})),
  elsewhere: tryDo(() => fs.writeFileSync(${JSON.stringify(join(elsewhere, "x"))}, "x")),
  settings: tryDo(() => fs.writeFileSync(${JSON.stringify(join(root, "mcp.json"))}, "{}")),
  workspace: tryDo(() => fs.writeFileSync(${JSON.stringify(join(root, "notes.txt"))}, "x")),
  beside: tryDo(() => fs.writeFileSync("beside.txt", "x")),
  liveDb: tryDo(() => fs.readFileSync(${JSON.stringify(join(root, "kos.sqlite"))})),
  db: tryDo(() => fs.readFileSync(process.env.KOS_DB)),
};
out.network = await fetch("http://1.1.1.1/", { signal: AbortSignal.timeout(3000) }).then(() => "yes", () => "no");
console.log(JSON.stringify(out));`;
    const reached = (stdout: unknown): Record<string, string> => JSON.parse(String(stdout).trim()) as Record<string, string>;

    it("tests a skill with no network, writing only its scratch copy, and the live database unread", async () => {
      skill("probe", "script", probe());
      const tested = await call("skills.test", { name: "probe" });
      expect(tested.json).toMatchObject({ ok: true });
      expect(reached(tested.json!["stdout"])).toEqual({ home: "no", elsewhere: "no", settings: "no", workspace: "no", beside: "yes", liveDb: "no", db: "yes", network: "no" });
      // What it wrote beside itself went with the scratch copy.
      expect(existsSync(join(root, "skills", "probe", "beside.txt"))).toBe(false);
      expect(existsSync(join(root, "notes.txt"))).toBe(false);
    });

    it("runs a promoted skill unasked, yet still in the jail: the workspace and its database, not the owner's home, KOS's settings or past the workspace", async () => {
      skill("probe", "script", probe());
      promoted["probe"] = hashOf("probe");
      expect(registry.classify("skills.run", { name: "probe" }).tier).toBe("safe");
      const ran = await call("skills.run", { name: "probe" });
      expect(ran.json).toMatchObject({ ok: true });
      const out = reached(ran.json!["stdout"]);
      expect(out).toMatchObject({ home: "no", elsewhere: "no", settings: "no", workspace: "yes", liveDb: "yes", db: "yes" });
      expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("x");
      expect(existsSync(join(elsewhere, "x"))).toBe(false);
    });
  });

  it("asks again to run a committed skill once its files change", async () => {
    skill("danger", "script", "import fs from 'node:fs'; fs.rmSync('x', { force: true })");
    const { done, asked } = await ask("danger");
    approvals.approve(asked.id, "owner", { via: "dashboard" });
    expect((await done).isError).toBe(false);
    expect(registry.classify("skills.run", { name: "danger" }).tier).toBe("safe");
    writeFileSync(join(ws.root, "skills", "danger", "run.mjs"), "import fs from 'node:fs'; fs.rmSync('y', { force: true })", "utf8");
    expect(registry.classify("skills.run", { name: "danger" }).tier).toBe("risky");
    // The manifest is part of what was approved too.
    writeFileSync(join(ws.root, "skills", "danger", "run.mjs"), "import fs from 'node:fs'; fs.rmSync('x', { force: true })", "utf8");
    expect(registry.classify("skills.run", { name: "danger" }).tier).toBe("safe");
    writeFileSync(join(ws.root, "skills", "danger", "skill.json"), JSON.stringify({ name: "danger", description: "now different", kind: "script", entry: "run.mjs" }), "utf8");
    expect(registry.classify("skills.run", { name: "danger" }).tier).toBe("risky");
  });

  it("classifies create, use, test and list as safe; run, promote and commit as risky", () => {
    for (const safe of ["skills.list", "skills.create", "skills.use", "skills.test"]) {
      expect(registry.classify(safe, {}).tier).toBe("safe");
    }
    for (const risky of ["skills.run", "skills.commit", "skills.promote"]) {
      expect(registry.classify(risky, {}).tier).toBe("risky");
    }
  });
});
