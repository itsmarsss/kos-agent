import { describe, expect, it } from "vitest";

import { CdpClient, type CdpSocket } from "./cdp.js";

/**
 * Commands get ids and their replies find them; events reach every listener
 * with their session; a hang-up fails what is waiting and says so once.
 */

class FakeSocket implements CdpSocket {
  sent: Record<string, unknown>[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.closed = true;
  }
  reply(id: number, result: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify({ id, result }) });
  }
  fail(id: number, message: string): void {
    this.onmessage?.({ data: JSON.stringify({ id, error: { code: -1, message } }) });
  }
  event(method: string, params: Record<string, unknown>, sessionId?: string): void {
    this.onmessage?.({ data: JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }) });
  }
}

async function dialed(): Promise<{ client: CdpClient; socket: FakeSocket; closed: () => number }> {
  let socket!: FakeSocket;
  const client = new CdpClient((url) => {
    socket = new FakeSocket();
    expect(url).toBe("ws://127.0.0.1:9225/devtools/browser/x");
    return socket;
  });
  let closes = 0;
  const dial = client.dial("ws://127.0.0.1:9225/devtools/browser/x", () => closes++);
  socket.onopen?.({});
  await dial;
  return { client, socket, closed: () => closes };
}

describe("the CDP client", () => {
  it("numbers commands, matches replies, and carries a tab's session", async () => {
    const { client, socket } = dialed().then((d) => d) as unknown as { client: CdpClient; socket: FakeSocket };
    const d = await dialed();
    const p1 = d.client.send("Target.getTargets");
    const p2 = d.client.send("Page.startScreencast", { format: "jpeg" }, "S1");
    expect(d.socket.sent).toEqual([
      { id: 1, method: "Target.getTargets", params: {} },
      { id: 2, method: "Page.startScreencast", params: { format: "jpeg" }, sessionId: "S1" },
    ]);
    d.socket.reply(2, {});
    d.socket.reply(1, { targetInfos: [] });
    expect(await p1).toEqual({ targetInfos: [] });
    expect(await p2).toEqual({});
    void client;
    void socket;
  });

  it("rejects a command the browser refuses, and times nothing else out", async () => {
    const d = await dialed();
    const p = d.client.send("Nope.nope");
    d.socket.fail(1, "'Nope.nope' wasn't found");
    await expect(p).rejects.toThrow(/wasn't found/);
  });

  it("hands events on with their session, and tells once when the browser hangs up", async () => {
    const d = await dialed();
    const seen: unknown[] = [];
    d.client.on((e) => seen.push(e));
    d.socket.event("Target.targetCreated", { targetInfo: { targetId: "T1" } });
    d.socket.event("Page.screencastFrame", { data: "AAAA" }, "S1");
    expect(seen).toEqual([
      { method: "Target.targetCreated", params: { targetInfo: { targetId: "T1" } } },
      { method: "Page.screencastFrame", params: { data: "AAAA" }, sessionId: "S1" },
    ]);
    const waiting = d.client.send("Target.getTargets");
    d.socket.onclose?.({});
    await expect(waiting).rejects.toThrow(/hung up/);
    expect(d.closed()).toBe(1);
    expect(d.client.open).toBe(false);
    await expect(d.client.send("Target.getTargets")).rejects.toThrow(/not connected/);
  });

  it("fails to dial when the socket errors", async () => {
    let socket!: FakeSocket;
    const client = new CdpClient(() => {
      socket = new FakeSocket();
      return socket;
    });
    const dial = client.dial("ws://127.0.0.1:1/x", () => {});
    socket.onerror?.({});
    await expect(dial).rejects.toThrow(/could not reach/);
  });
});
