import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { waitForPortFree } from "./host.js";

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
