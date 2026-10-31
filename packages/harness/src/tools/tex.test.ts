import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { toolRegistryContext } from "../modules/loader.js";
import { findProgram } from "../sandbox/env.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Workspace } from "../store/workspace.js";
import { createTexModule, type TexModuleOptions, type TexResult } from "./tex.js";

const PATH = `${process.env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin`;
const tectonic = findProgram("tectonic", PATH);
// Kept across runs, so only the first run on a machine fetches the bundle.
const CACHE = join(homedir(), ".kos-tex-test", "cache");

describe("tex.pdf", () => {
  let root: string;
  let ws: Workspace;

  async function registryWith(options: TexModuleOptions): Promise<ToolRegistry> {
    const registry = new ToolRegistry();
    const ctx = toolRegistryContext(registry, { workspace: ws, db: ws.db, secrets: new SecretsRegistry() });
    await createTexModule(options).activate(ctx);
    return registry;
  }

  async function typeset(registry: ToolRegistry, path: string): Promise<TexResult> {
    const res = await registry.execute("tex.pdf", { path });
    expect(res.isError, res.content).toBe(false);
    return JSON.parse(res.content) as TexResult;
  }

  beforeEach(() => {
    const base = join(homedir(), ".kos-tex-test");
    mkdirSync(base, { recursive: true });
    root = mkdtempSync(join(base, "ws-"));
    ws = Workspace.open(root);
    mkdirSync(join(root, "docs"), { recursive: true });
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("runs without asking only where the macOS jail holds it", async () => {
    const mac = await registryWith({ platform: "darwin", contained: false });
    expect(mac.classify("tex.pdf", { path: "a.tex" }).tier).toBe("safe");
    const container = await registryWith({ platform: "linux", contained: true });
    expect(container.classify("tex.pdf", { path: "a.tex" }).tier).toBe("risky");
  });

  it("takes only a .tex in the workspace, and says when tectonic is missing", async () => {
    const registry = await registryWith({ tectonic: "no-such-tectonic" });
    writeFileSync(join(root, "docs", "a.tex"), "x", "utf8");
    expect((await registry.execute("tex.pdf", { path: "docs/a.md" })).content).toMatch(/\.tex/);
    expect((await registry.execute("tex.pdf", { path: "docs/gone.tex" })).content).toMatch(/no such file/);
    expect((await registry.execute("tex.pdf", { path: "docs/a.tex" })).content).toMatch(/not installed/);
  });

  describe.runIf(process.platform === "darwin" && tectonic)("with tectonic", () => {
    it("puts the PDF beside the source", { timeout: 300_000 }, async () => {
      const registry = await registryWith({ tectonic: tectonic!, cache: CACHE });
      writeFileSync(
        join(root, "docs", "notes.tex"),
        "\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\n\\[ e^{i\\pi} + 1 = 0 \\]\n\\end{document}\n",
        "utf8",
      );
      const r = await typeset(registry, "docs/notes.tex");
      expect(r).toMatchObject({ ok: true, pdf: "docs/notes.pdf", pages: 1 });
      expect(existsSync(join(root, "docs", "notes.pdf"))).toBe(true);
    });

    it("hands back where TeX stopped, and cannot read KOS's own files", { timeout: 300_000 }, async () => {
      const registry = await registryWith({ tectonic: tectonic!, cache: CACHE });
      writeFileSync(join(root, "docs", "bad.tex"), "\\documentclass{article}\n\\begin{document}\n\\nosuchcommand\n\\end{document}\n", "utf8");
      const bad = await typeset(registry, "docs/bad.tex");
      expect(bad.ok).toBe(false);
      expect(bad.log).toMatch(/bad\.tex:3/);

      // The workspace is there to read; KOS's own files are not.
      writeFileSync(join(root, "shared.tex"), "Shared words.", "utf8");
      writeFileSync(join(root, "docs", "uses.tex"), "\\documentclass{article}\n\\begin{document}\n\\input{../shared.tex}\n\\end{document}\n", "utf8");
      expect((await typeset(registry, "docs/uses.tex")).ok).toBe(true);
      writeFileSync(join(root, "mcp.json"), "{}", "utf8");
      writeFileSync(join(root, "docs", "peek.tex"), "\\documentclass{article}\n\\begin{document}\n\\input{../mcp.json}\n\\end{document}\n", "utf8");
      const peek = await typeset(registry, "docs/peek.tex");
      expect(peek.ok).toBe(false);
      expect(existsSync(join(root, "docs", "peek.pdf"))).toBe(false);
    });
  });
});
