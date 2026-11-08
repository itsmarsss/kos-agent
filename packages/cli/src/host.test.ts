import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { SurfaceDownError, type ChannelAdapter } from "@kos/harness";

import { dashboardUrlFor, roomCursorsIn, surfaceUp, waitForPortFree } from "./host.js";

describe("waitForPortFree", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await new Promise((r) => server!.close(() => r(null)));
    server = undefined;
  });

  it("returns immediately when nothing is listening", async () => {
    // 4498 is not bound by anything in this suite.
    expect(await waitForPortFree("127.0.0.1", 4498, 1000)).toBe(true);
  });

  it("reports a held port as not free within the timeout", async () => {
    server = createServer();
    await new Promise((r) => server!.listen(4499, "127.0.0.1", () => r(null)));
    // This is the race a restart has to survive: the old host still holds it.
    expect(await waitForPortFree("127.0.0.1", 4499, 600)).toBe(false);
  });

  it("returns true once the holder lets go", async () => {
    server = createServer();
    await new Promise((r) => server!.listen(4497, "127.0.0.1", () => r(null)));
    setTimeout(() => server?.close(), 200);
    expect(await waitForPortFree("127.0.0.1", 4497, 4000)).toBe(true);
  });
});

describe("surfaceUp", () => {
  const adapter = (connected: boolean): ChannelAdapter => ({ name: "discord", connected: () => connected } as unknown as ChannelAdapter);

  it("hands back a surface that is wired and up", () => {
    const up = adapter(true);
    expect(surfaceUp(new Map([["discord", () => up]]), "discord", false)).toBe(up);
  });

  it("takes the surface-down path for one wired but dropped, rather than sending into it", () => {
    const surfaces = new Map<string, () => ChannelAdapter | undefined>([["discord", () => adapter(false)], ["sms", () => adapter(true)]]);
    expect(() => surfaceUp(surfaces, "discord", false)).toThrow(SurfaceDownError);
    expect(() => surfaceUp(surfaces, "discord", false)).toThrow(/Connected: sms/);
  });

  it("refuses a surface that is not wired here at all", () => {
    expect(() => surfaceUp(new Map(), "telegram", true)).toThrow(/no telegram surface here/);
  });
});

describe("roomCursorsIn", () => {
  it("keeps each room's last message, moving only forward", () => {
    const store = new Map<string, unknown>();
    const settings = { get: <T,>(k: string) => store.get(k) as T | undefined, set: (k: string, v: unknown) => void store.set(k, v) };
    const cursors = roomCursorsIn(settings);
    cursors.advance("dm1", "1000000000000000002");
    cursors.advance("dm1", "999999999999999999");
    cursors.advance("t1", "5");
    expect(cursors.get("dm1")).toBe("1000000000000000002");
    expect(cursors.rooms()).toEqual(["dm1", "t1"]);
  });
});

describe("dashboardUrlFor", () => {
  it("links to the public URL when there is one, and to this host otherwise", () => {
    const was = process.env.KOS_PUBLIC_URL;
    try {
      process.env.KOS_PUBLIC_URL = "https://kos.example";
      expect(dashboardUrlFor("127.0.0.1", 4317)).toBe("https://kos.example");
      delete process.env.KOS_PUBLIC_URL;
      expect(dashboardUrlFor("0.0.0.0", 4317)).toBe("http://localhost:4317");
    } finally {
      if (was === undefined) delete process.env.KOS_PUBLIC_URL;
      else process.env.KOS_PUBLIC_URL = was;
    }
  });
});
