import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DeviceStore } from "@kos/computer";
import { AuditLog, Workspace } from "@kos/harness";

import { runHost, type RunningHost } from "./host.js";
import { portFree } from "./porttaken.js";

/** A free port in the range these tests are allowed, so none lands on a live host; from the top, away from porttaken.test's. */
async function freePort(): Promise<number> {
  for (let port = 4429; port >= 4417; port--) if ((await portFree("127.0.0.1", port)) && (await portFree("127.0.0.1", port + 2))) return port;
  throw new Error("no free port in 4417-4431");
}

/*
 * The host's wiring, booted for real on a scratch HOME and workspace: the
 * computer module activates inside Kernel.boot, and a KOS for Mac install a
 * restart cut short is settled (and audited) there. That once read `kernel`
 * before boot returned, and computer use stayed off for the whole boot.
 */
describe("a host booting after a restart cut a Mac install short", () => {
  const saved = { ...process.env };
  let home: string;
  let workspace: string;
  let host: RunningHost | undefined;
  let port: number;
  let device: string;

  beforeAll(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "kos-boot-")));
    workspace = join(home, "ws");
    mkdirSync(workspace);
    process.env.HOME = home;
    process.env.KOS_DEVICE_MAC_INSTALL = "/usr/bin/true";
    for (const key of ["KOS_DASHBOARD_TOKEN", "KOS_VAULT_KEY", "KOS_VAULT_DIR", "KOS_WRITE_KEY_FILE", "KOS_DEVICE_KEY_FILE", "KOS_DEVICE_LOCAL_KEY_FILE", "KOS_DEVICE_LAN", "KOS_OWNER_IMESSAGE", "KOS_TWILIO_SID", "KOS_UI_DIST"]) delete process.env[key];
    const ws = Workspace.open(workspace);
    const store = new DeviceStore(ws.db);
    device = store.add({ name: "Studio", platform: "macos", publicKey: "k" }).id;
    store.setAttempt({ device, build: "b2", from: "b1", outcome: "installing" });
    ws.close();
    port = await freePort();
    host = await runHost({ rootDir: workspace, allowedHosts: [], host: "127.0.0.1", port, discord: false, sitesPort: 0 });
  }, 60_000);

  afterAll(async () => {
    await host?.stop();
    process.env = saved;
    rmSync(home, { recursive: true, force: true });
  });

  it("leaves a second start on its port unbooted: refused before its kernel opens a workspace", async () => {
    const other = join(home, "other");
    await expect(runHost({ rootDir: other, allowedHosts: [], host: "127.0.0.1", port, discord: false, sitesPort: 0 })).rejects.toThrow(/already in use by another KOS/);
    expect(existsSync(join(other, "kos.sqlite"))).toBe(false);
  });

  it("refuses to listen beyond loopback without the dashboard token", async () => {
    await expect(runHost({ rootDir: join(home, "lan"), allowedHosts: [], host: "0.0.0.0", port, discord: false, sitesPort: 0 })).rejects.toThrow(/KOS_DASHBOARD_TOKEN/);
  });

  it("comes up with computer use on, and the cut-off install failed and written down", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/devices`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { devices: { id: string }[] };
    expect(body.devices.map((d) => d.id)).toEqual([device]);
    expect(await host!.stop()).toEqual([]);
    host = undefined;
    const ws = Workspace.open(workspace);
    try {
      expect(new DeviceStore(ws.db).attempt(device, "b2")).toMatchObject({ outcome: "failed", detail: "KOS restarted during the install" });
      expect(new AuditLog(ws.db).recent().some((r) => r.result === "failed: KOS restarted during the install")).toBe(true);
    } finally {
      ws.close();
    }
  });
});
