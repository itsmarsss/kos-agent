import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import { listenThen } from "./host.js";

describe("listenThen", () => {
  it("keeps the key only once the port is this host's, never after a failed start", async () => {
    const live = createServer();
    await new Promise<void>((r) => live.listen(0, "127.0.0.1", r));
    const port = (live.address() as AddressInfo).port;
    let kept = 0;
    const second = createServer();
    await expect(listenThen(second, port, "127.0.0.1", () => void kept++)).rejects.toThrow(/already in use/);
    expect(kept).toBe(0);
    await new Promise((r) => live.close(r));
    const first = createServer();
    await listenThen(first, port, "127.0.0.1", () => void kept++);
    expect(kept).toBe(1);
    await new Promise((r) => first.close(r));
  });
});
