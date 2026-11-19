import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import type { Inference } from "../agent/loop.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Kernel } from "./kernel.js";
import { createDashboardServer } from "./server.js";
import { signUrl } from "./signedurl.js";
import { SOCKET_PATH, createDashboardSocket, frameMessage, type DashboardSocket } from "./socket.js";

/**
 * The dashboard's one live connection: it lets in the dashboard's own page
 * and no other site, carries progress and the browser, and lets go of a tab
 * when the window that took it goes.
 */

const stub: Inference = {
  async generate() {
    return { content: [{ type: "text", text: "hi" }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" };
  },
};

describe("the dashboard's socket", () => {
  let root: string;
  let kernel: Kernel;
  let server: Server;
  let live: DashboardSocket;
  let base: string;

  const KEY = "boot-key";

  async function start(token?: string): Promise<void> {
    server = createDashboardServer(kernel, { ...(token ? { token } : {}), writeKey: KEY });
    live = createDashboardSocket(kernel, { ...(token ? { token } : {}), writeKey: KEY });
    server.on("upgrade", (req, socket, head) => {
      if (!live.upgrade(req, socket, head)) socket.destroy();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  /** A connection from the dashboard's own page unless said, with this boot's key unless said, and what it has heard so far. */
  async function connect(headers: Record<string, string> = { origin: `http://${base.slice("ws://".length)}` }, key: string | undefined = KEY): Promise<{ ws: WebSocket; heard: Record<string, unknown>[] }> {
    const ws = new WebSocket(`${base}/api/socket${key ? `?key=${key}` : ""}`, { headers });
    const heard: Record<string, unknown>[] = [];
    ws.on("message", (data, binary) => {
      if (!binary) heard.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return { ws, heard };
  }

  const until = async (check: () => boolean): Promise<void> => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-socket-"));
    kernel = await Kernel.boot({ rootDir: root, secrets: new SecretsRegistry(), inference: stub, chrome: { port: 1, exists: () => false } });
  });

  afterEach(async () => {
    live?.close();
    await new Promise((r) => server?.close(r));
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("lets in the dashboard's own page, and refuses any other site, a caller that names none, and a rebound name", async () => {
    await start();
    const host = base.slice("ws://".length);
    await expect(connect({ origin: `http://${host}` })).resolves.toBeDefined();
    await expect(connect({})).rejects.toThrow(/403/);
    await expect(connect({ origin: "https://evil.example" })).rejects.toThrow(/403/);
    await expect(connect({ origin: "http://evil.example", host: "evil.example" })).rejects.toThrow(/403|421/);
  });

  it("asks for the dashboard's token when it has one", async () => {
    await start("s3cret");
    const origin = `http://${base.slice("ws://".length)}`;
    await expect(connect({ origin })).rejects.toThrow(/403/);
    await expect(connect({ origin, "x-kos-token": "s3cret" })).resolves.toBeDefined();
    // A browser's socket sends no headers of its own: it opens with a ticket, and never with the token in its address.
    const opened = (path: string): Promise<void> => {
      const ws = new WebSocket(`${base}${path}`, { headers: { origin } });
      return new Promise<void>((done, fail) => (ws.once("open", () => (ws.close(), done())), ws.once("error", fail)));
    };
    await expect(opened("/api/socket?token=s3cret")).rejects.toThrow(/403/);
    const ticket = signUrl(SOCKET_PATH, "s3cret")!.url;
    await expect(opened(ticket)).resolves.toBeUndefined();
    // Spent on the connection it opened.
    await expect(opened(ticket)).rejects.toThrow(/403/);
    await expect(opened(signUrl(SOCKET_PATH, "other")!.url)).rejects.toThrow(/403/);
  });

  it("lets a window without this boot's key watch, but not put its hand on the browser", async () => {
    await start();
    const { ws, heard } = await connect(undefined, "");
    ws.send(JSON.stringify({ op: "take", tab: "T1" }));
    ws.send(JSON.stringify({ op: "input", tab: "T1", type: "input_mouse" }));
    await until(() => heard.filter((m) => m["type"] === "error").length >= 2);
    expect(heard.filter((m) => m["type"] === "error").map((m) => m["error"])).toEqual([expect.stringMatching(/no key/), expect.stringMatching(/no key/)]);
  });

  it("carries a turn's progress, caught up first on what is running", async () => {
    await start();
    kernel.progress.emit({ kind: "turn-start", conversationId: "c1" });
    const { ws, heard } = await connect();
    ws.send(JSON.stringify({ op: "watch", channel: "events" }));
    await until(() => heard.length > 0);
    expect(heard[0]).toMatchObject({ channel: "events", event: { kind: "turn-start", conversationId: "c1" } });
    kernel.progress.emit({ kind: "delta", conversationId: "c1", of: "text", text: "hello" });
    await until(() => heard.length > 1);
    expect(heard[1]).toMatchObject({ channel: "events", event: { kind: "delta", text: "hello" } });
    ws.send(JSON.stringify({ op: "unwatch", channel: "events" }));
    await new Promise((r) => setTimeout(r, 30));
    kernel.progress.emit({ kind: "delta", conversationId: "c1", of: "text", text: "unheard" });
    await new Promise((r) => setTimeout(r, 30));
    expect(heard).toHaveLength(2);
  });

  it("tells the browser's status, and says why a hand on a tab that is not there went nowhere", async () => {
    await start();
    const { ws, heard } = await connect();
    ws.send(JSON.stringify({ op: "watch", channel: "browser" }));
    await until(() => heard.some((m) => m["type"] === "tabs"));
    expect(heard.find((m) => m["type"] === "status")).toMatchObject({ channel: "browser", status: { attached: false, tabs: [] } });
    ws.send(JSON.stringify({ op: "take", tab: "T1" }));
    ws.send(JSON.stringify({ op: "input", tab: "T1", type: "input_mouse", eventType: "mousePressed", x: 1, y: 1 }));
    await until(() => heard.filter((m) => m["type"] === "error").length >= 2);
    expect(heard.filter((m) => m["type"] === "error").map((m) => m["error"])).toEqual(["no such tab", "no such tab"]);
  });

  it("sends a frame as bytes: its header's length, the header, the picture", () => {
    const message = frameMessage("T1", { seq: 3, data: Buffer.from("JPEG").toString("base64"), width: 800, height: 600, at: 5 });
    const length = message.readUInt32BE(0);
    expect(JSON.parse(message.subarray(4, 4 + length).toString())).toEqual({ channel: "browser", type: "frame", tab: "T1", seq: 3, width: 800, height: 600, at: 5 });
    expect(message.subarray(4 + length).toString()).toBe("JPEG");
  });

  it("lets go of the tabs a window took when it closes", async () => {
    await start();
    const released: string[] = [];
    const releaseAll = kernel.browser.releaseAll.bind(kernel.browser);
    kernel.browser.releaseAll = (holder: string) => {
      released.push(holder);
      releaseAll(holder);
    };
    const { ws } = await connect();
    ws.close();
    await until(() => released.length > 0);
    expect(released).toEqual(["window-1"]);
  });
});
