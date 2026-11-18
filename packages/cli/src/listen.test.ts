import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import { hostNamesOf, listenThen } from "./host.js";

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

describe("hostNamesOf", () => {
  it("takes the bound host, the public url's, the Wi-Fi host and every name in KOS_HOST_NAMES", () => {
    expect(hostNamesOf("127.0.0.1", { KOS_PUBLIC_URL: "https://kos.example.com:8443/x", KOS_DEVICE_LAN_HOST: "mac.local", KOS_HOST_NAMES: " my-mac.tail1234.ts.net, tunnel.example ," })).toEqual([
      "127.0.0.1",
      "mac.local",
      "kos.example.com",
      "my-mac.tail1234.ts.net",
      "tunnel.example",
    ]);
  });
});
