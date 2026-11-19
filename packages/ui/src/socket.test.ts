// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { socketPath } from "./socket.js";

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  document.head.innerHTML = "";
});

describe("where the socket opens", () => {
  it("carries this boot's key with no token held", async () => {
    document.head.innerHTML = '<meta name="kos-write" content="k1">';
    expect(await socketPath()).toBe("/api/socket?key=k1");
  });

  it("opens with a ticket KOS signs, never with the token in the address", async () => {
    sessionStorage.setItem("kos.dashboardToken", "s3cret");
    const kos = vi.fn(async () => new Response(JSON.stringify({ url: "/api/socket?kos_sig=1.abc", expiresAt: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", kos);
    const path = await socketPath();
    expect(path).toBe("/api/socket?kos_sig=1.abc");
    expect(path).not.toContain("s3cret");
    expect(kos).toHaveBeenCalledWith("/api/sign?url=%2Fapi%2Fsocket", expect.objectContaining({ headers: { "x-kos-token": "s3cret" } }));
  });
});
