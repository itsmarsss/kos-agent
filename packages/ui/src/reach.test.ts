// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, changeHeaders } from "./api.js";
import { missed, reach, reached, resetReach } from "./reach.js";

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const page = (key: string): Response => new Response(`<html><head><meta name="kos-write" content="${key}"></head></html>`, { status: 200 });

beforeEach(() => {
  resetReach();
  document.head.innerHTML = '<meta name="kos-write" content="old">';
});
afterEach(() => vi.unstubAllGlobals());

describe("whether KOS is answering", () => {
  it("takes one miss as a blip and misses apart as down, until KOS answers", () => {
    missed(false, 1_000);
    expect(reach().down).toBe(false);
    missed(false, 3_000);
    expect(reach().down).toBe(true);
    reached();
    expect(reach().down).toBe(false);
  });

  it("is down at once when a change the owner made never arrived, and says so in words", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    await expect(api.renameConversation("c1", "x")).rejects.toThrow(/KOS is not answering/);
    expect(reach().down).toBe(true);
  });
});

describe("a change after KOS restarted under the tab", () => {
  it("renews the write key from the page and goes again, once", async () => {
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string, init?: RequestInit) => {
        if (path === "/") return Promise.resolve(page("new"));
        const key = (init?.headers as Record<string, string>)["x-kos-write"]!;
        sent.push(key);
        return Promise.resolve(key === "new" ? json(200, { ok: true }) : json(403, { error: "A change to KOS needs this boot's write key.", code: "write-key" }));
      }),
    );
    await api.renameConversation("c1", "x");
    expect(sent).toEqual(["old", "new"]);
    // Kept, so the next change and the socket use it.
    expect(changeHeaders()["x-kos-write"]).toBe("new");
    expect(reach().stale).toBe(false);
  });

  it("asks for a reload when the key cannot be renewed, without the terminal's words", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string) => Promise.resolve(path === "/" ? page("old") : json(403, { error: "From a terminal, use the kos CLI", code: "write-key" }))),
    );
    await expect(api.renameConversation("c1", "x")).rejects.toThrow(/KOS restarted\. Reload the page/);
    expect(reach().stale).toBe(true);
  });

  it("leaves any other refusal as it was", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(json(403, { error: "not yours" }))));
    await expect(api.renameConversation("c1", "x")).rejects.toThrow("not yours");
    expect(reach().stale).toBe(false);
  });
});
