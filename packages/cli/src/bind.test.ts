import { describe, expect, it } from "vitest";

import { bindRefusal, dialHost, isLocalHost, isLoopbackHost } from "./bind.js";

describe("binding beyond loopback", () => {
  it("knows loopback by name and address, mapped addresses included", () => {
    for (const h of ["127.0.0.1", "127.0.0.2", "localhost", "::1", "[::1]", "::ffff:127.0.0.1"]) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ["0.0.0.0", "::", "192.168.1.5", "kos.example.com", "127.example.com"]) expect(isLoopbackHost(h)).toBe(false);
  });

  it("refuses any other host without the dashboard token, and names it", () => {
    expect(bindRefusal("127.0.0.1", undefined)).toBeUndefined();
    expect(bindRefusal("::1", undefined)).toBeUndefined();
    expect(bindRefusal("0.0.0.0", undefined)).toMatch(/KOS_DASHBOARD_TOKEN/);
    expect(bindRefusal("192.168.1.5", undefined)).toMatch(/refusing to listen on 192\.168\.1\.5/);
    expect(bindRefusal("0.0.0.0", "t0k")).toBeUndefined();
  });
});

describe("a host the CLI may send credentials to", () => {
  it("is this machine, never a name from elsewhere", () => {
    expect(isLocalHost("127.0.0.1")).toBe(true);
    expect(isLocalHost("0.0.0.0")).toBe(true);
    expect(isLocalHost("attacker.example")).toBe(false);
    expect(isLocalHost("203.0.113.9")).toBe(false);
  });

  it("dials an any-address on loopback", () => {
    expect(dialHost("0.0.0.0")).toBe("127.0.0.1");
    expect(dialHost("::")).toBe("::1");
    expect(dialHost("127.0.0.1")).toBe("127.0.0.1");
  });
});
