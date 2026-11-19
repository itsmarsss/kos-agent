// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./api.js";
import { RENEW_BEFORE_MS, Signed } from "./signed.js";

let kos: ReturnType<typeof vi.fn>;
let signs = 0;
beforeEach(() => {
  signs = 0;
  kos = vi.fn(async (path: string) => {
    if (path.startsWith("/api/sign?")) {
      const url = new URLSearchParams(path.slice(path.indexOf("?") + 1)).get("url")!;
      signs += 1;
      return new Response(JSON.stringify({ url: `${url}${url.includes("?") ? "&" : "?"}kos_sig=${signs}.abc`, expiresAt: Date.now() + 900_000 }), { status: 200 });
    }
    return new Response("x", { status: 200, headers: { "content-disposition": 'attachment; filename="a.pdf"' } });
  });
  vi.stubGlobal("fetch", kos);
  URL.createObjectURL = () => "blob:x";
  URL.revokeObjectURL = () => undefined;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

const img = (src: string, again: () => boolean) => <img src={src} alt="thumb" onError={again} />;

describe("what the browser fetches by itself", () => {
  it("points straight at KOS with no token held", () => {
    render(<Signed url="/api/approvals/3/picture">{img}</Signed>);
    expect(screen.getByAltText("thumb").getAttribute("src")).toBe("/api/approvals/3/picture");
    expect(kos).not.toHaveBeenCalled();
  });

  it("waits for KOS to sign the address when a token is held, and never puts the token in it", async () => {
    sessionStorage.setItem("kos.dashboardToken", "s3cret");
    render(<Signed url="/api/file/media?path=a.mp4">{img}</Signed>);
    expect(screen.queryByAltText("thumb")).toBeNull();
    const shown = await screen.findByAltText("thumb");
    expect(shown.getAttribute("src")).toBe("/api/file/media?path=a.mp4&kos_sig=1.abc");
    expect(shown.getAttribute("src")).not.toContain("s3cret");
    expect((kos.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ "x-kos-token": "s3cret" });
  });

  it("signs again shortly before the signature lapses, and once when the element fails with it", async () => {
    sessionStorage.setItem("kos.dashboardToken", "s3cret");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      render(<Signed url="/api/approvals/3/picture">{img}</Signed>);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByAltText("thumb").getAttribute("src")).toBe("/api/approvals/3/picture?kos_sig=1.abc");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(900_000 - RENEW_BEFORE_MS - 1000);
      });
      expect(signs).toBe(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(screen.getByAltText("thumb").getAttribute("src")).toBe("/api/approvals/3/picture?kos_sig=2.abc");
      // A lazy picture that loads late, past its signature: its failure signs it again, once.
      fireEvent.error(screen.getByAltText("thumb"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByAltText("thumb").getAttribute("src")).toBe("/api/approvals/3/picture?kos_sig=3.abc");
      // Failing again with the fresh one is the file's doing: no loop of signatures.
      fireEvent.error(screen.getByAltText("thumb"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(signs).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends the token with every file it fetches as bytes", async () => {
    sessionStorage.setItem("kos.dashboardToken", "s3cret");
    await api.imageUrl("a.png");
    await api.thumbUrl("a.pdf", 200);
    await api.downloadFile("a.pdf");
    await api.exportArtifact("p1", "pdf");
    expect(kos).toHaveBeenCalledTimes(4);
    for (const [, init] of kos.mock.calls) expect((init as RequestInit).headers).toMatchObject({ "x-kos-token": "s3cret" });
  });
});
