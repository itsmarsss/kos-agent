import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { toolRegistryContext } from "../modules/loader.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Workspace } from "../store/workspace.js";
import { createPythonModule, type PythonModuleOptions, type PythonResult } from "./python.js";

const onMac = process.platform === "darwin";

async function registryWith(ws: Workspace, options: PythonModuleOptions): Promise<ToolRegistry> {
  const registry = new ToolRegistry();
  const ctx = toolRegistryContext(registry, { workspace: ws, db: ws.db, secrets: new SecretsRegistry() });
  await createPythonModule(options).activate(ctx);
  return registry;
}

describe("python.run's tier", () => {
  let root: string;
  let ws: Workspace;

  beforeEach(() => {
    root = mkdtempSync(join(homedir(), ".kos-python-tier-"));
    ws = Workspace.open(root);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("runs without asking only where the macOS jail holds it", async () => {
    const mac = await registryWith(ws, { platform: "darwin", contained: false });
    expect(mac.classify("python.run", { code: "print(1)" }).tier).toBe("safe");
    const container = await registryWith(ws, { platform: "linux", contained: true });
    expect(container.classify("python.run", { code: "print(1)" }).tier).toBe("risky");
  });
});

describe.runIf(onMac)("python.run on macOS", () => {
  let root: string;
  let ws: Workspace;
  let registry: ToolRegistry;
  let outsideHome: string;

  async function run(code: string, timeout?: number): Promise<PythonResult & { pictures: number }> {
    const res = await registry.execute("python.run", { code, ...(timeout ? { timeout } : {}) });
    expect(res.isError, res.content).toBe(false);
    return { ...(JSON.parse(res.content) as PythonResult), pictures: res.images?.length ?? 0 };
  }

  beforeEach(async () => {
    // Under the real home, as the owner's workspace is, so the test proves
    // the workspace is carved back out of the denied home.
    const base = join(homedir(), ".kos-python-test");
    mkdirSync(base, { recursive: true });
    root = mkdtempSync(join(base, "ws-"));
    ws = Workspace.open(root);
    outsideHome = join(base, "outside.txt");
    writeFileSync(outsideHome, "private", "utf8");
    registry = await registryWith(ws, { timeoutSeconds: 10 });
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideHome, { force: true });
  });

  it("hands back what the program printed", async () => {
    const r = await run("import math\nprint(sum(range(101)), round(math.pi, 4))");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("5050 3.1416");
    expect(r.files).toBeUndefined();
    // Nothing kept, so no folder is left behind, and its scratch is gone.
    expect(existsSync(join(root, "scratch", "python")) ? readdirSync(join(root, "scratch", "python")) : []).toEqual([]);
    expect(readdirSync(join(root, ".kos", "tmp")).filter((n) => n.startsWith("python-"))).toEqual([]);
  });

  it("reads the workspace by relative path and writes only into its own folder", async () => {
    mkdirSync(join(root, "projects"), { recursive: true });
    writeFileSync(join(root, "projects", "n.csv"), "a\n1\n2\n", "utf8");
    const r = await run(
      [
        "import os",
        "print(sum(int(x) for x in open('projects/n.csv').read().split()[1:]))",
        "try:\n    open('projects/new.txt', 'w')\nexcept OSError as e:\n    print('blocked', e.errno)",
        "open(os.path.join(os.environ['OUT'], 'kept.txt'), 'w').write('ok')",
      ].join("\n"),
    );
    expect(r.stdout).toContain("3\n");
    expect(r.stdout).toContain("blocked");
    expect(existsSync(join(root, "projects", "new.txt"))).toBe(false);
    expect(r.files).toHaveLength(1);
    expect(r.files![0]).toMatch(/^scratch\/python\/[\w-]+\/kept\.txt$/);
    expect(existsSync(join(root, r.files![0]!))).toBe(true);
  });

  it("sees neither the owner's home, KOS's own files, nor the network", async () => {
    writeFileSync(join(root, "mcp.json"), "{}", "utf8");
    const r = await run(
      [
        "import socket",
        `for p in [${JSON.stringify(outsideHome)}, 'kos.sqlite', 'mcp.json']:`,
        "    try:\n        open(p).read(); print('read', p)\n    except OSError:\n        print('hidden', p)",
        "try:\n    socket.create_connection(('1.1.1.1', 80), timeout=3); print('online')\nexcept OSError:\n    print('offline')",
      ].join("\n"),
    );
    expect(r.stdout).not.toContain("read ");
    expect(r.stdout.match(/hidden/g)).toHaveLength(3);
    expect(r.stdout).toContain("offline");
  });

  it("shows a picture it saved", async () => {
    // A one-pixel PNG, written by hand so the test needs no plotting library.
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const r = await run(`import base64, os\nopen(os.path.join(os.environ['OUT'], 'dot.png'), 'wb').write(base64.b64decode('${png}'))`);
    expect(r.files?.[0]).toMatch(/dot\.png$/);
    expect(r.pictures).toBe(1);
  });

  it("stops a program that runs too long and says so", async () => {
    const r = await run("import time\ntime.sleep(5)", 1);
    expect(r.timedOut).toBe(true);
  });
});
