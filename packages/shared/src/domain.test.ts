import { describe, expect, it } from "vitest";

import { registrableDomain } from "./domain.js";

describe("the registrable domain", () => {
  it("is the part one owner holds", () => {
    expect(registrableDomain("login.github.com")).toBe("github.com");
    expect(registrableDomain("login.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("www.alice.github.io")).toBe("alice.github.io");
    expect(registrableDomain("pay.shop.myshopify.com")).toBe("shop.myshopify.com");
    expect(registrableDomain("login.github.com.evil.example")).toBe("evil.example");
    expect(registrableDomain("api.svc-abc.a.run.app")).toBe("svc-abc.a.run.app");
    expect(registrableDomain("raw.githubusercontent.com")).toBe("raw.githubusercontent.com");
    expect(registrableDomain("alice.notion.site")).toBe("alice.notion.site");
    expect(registrableDomain("pub-1.r2.dev")).toBe("pub-1.r2.dev");
  });

  it("leaves an address or a one-label host as it is", () => {
    expect(registrableDomain("127.0.0.1")).toBe("127.0.0.1");
    expect(registrableDomain("localhost")).toBe("localhost");
  });
});
