// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./api.js";
import { TokenGate } from "./TokenGate.js";

/** A KOS started with KOS_DASHBOARD_TOKEN=s3cret: every route is 401 without it. */
function tokenKos(): ReturnType<typeof vi.fn> {
  return vi.fn(async (_path: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (headers["x-kos-token"] !== "s3cret") return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
}

let kos: ReturnType<typeof vi.fn>;
beforeEach(() => {
  kos = tokenKos();
  vi.stubGlobal("fetch", kos);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

function enter(token: string): void {
  fireEvent.change(screen.getByPlaceholderText("not set"), { target: { value: token } });
  fireEvent.click(screen.getByRole("button", { name: "Hold" }));
}

describe("a KOS that asks for its token", () => {
  it("asks for it before the app draws, and opens once it is held", async () => {
    render(<TokenGate><p>the app</p></TokenGate>);
    await screen.findByText("KOS asks for its token");
    expect(screen.queryByText("the app")).toBeNull();
    enter("wrong");
    await screen.findByText(/did not take that token/);
    enter("s3cret");
    await screen.findByText("the app");
    const last = kos.mock.calls.at(-1)!;
    expect((last[1] as RequestInit).headers).toMatchObject({ "x-kos-token": "s3cret" });
  });

  it("asks again when a later request is refused", async () => {
    sessionStorage.setItem("kos.dashboardToken", "s3cret");
    render(<TokenGate><p>the app</p></TokenGate>);
    await screen.findByText("the app");
    sessionStorage.setItem("kos.dashboardToken", "rotated");
    await act(async () => {
      await api.tools().catch(() => undefined);
    });
    await waitFor(() => expect(screen.getByText("KOS asks for its token")).toBeTruthy());
  });
});
