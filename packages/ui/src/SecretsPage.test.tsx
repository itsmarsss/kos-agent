// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { REVEAL_MS } from "./SecretSheet.js";
import { SecretsPage } from "./SecretsPage.js";
import type { SecretSummary, VaultStatus } from "@kos/shared";

const login: SecretSummary = {
  handle: "github-login-9xq1",
  label: "GitHub",
  kind: "login",
  fields: ["username", "password"],
  hint: "••••••",
  use: { web: { origins: ["https://github.com"], frames: [] }, apps: [], http: { hosts: [] } },
  policy: { ask: "site", unattended: false, chats: null, grants: [{ origin: "https://github.com", at: Date.now() - 3_600_000 }] },
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: Date.now() - 7_200_000,
  source: "vault",
};
const env: SecretSummary = { ...login, handle: "OPENAI_KEY", label: "OpenAI", kind: "apikey", fields: ["token"], hint: "sk-…a1", use: { web: { origins: [], frames: [] }, apps: [], http: { hosts: ["api.openai.com"], as: "bearer" } }, policy: { ask: "always", unattended: false, chats: null, grants: [] }, source: "env" };

type Route = (method: string, body: unknown) => unknown;
let routes: Record<string, Route>;
let calls: { method: string; path: string; body: unknown }[];

function serve(state: VaultStatus["state"], extra: Record<string, Route> = {}): void {
  const status: VaultStatus = { state, slots: ["keyfile"], scrubbed: 3 };
  routes = {
    "GET /api/secrets/status": () => status,
    // A server that wrongly sent a value along: the page must still not draw it.
    "GET /api/secrets": () => ({ secrets: [{ ...login, value: "hunter2", values: { password: "hunter2" } }, env] }),
    "GET /api/secrets/github-login-9xq1/uses?limit=50": () => ({ uses: [{ id: 1, at: Date.now() - 60_000, tool: "secrets.fill", surface: "kos-browser", origin: "https://github.com", fields: ["password"], outcome: "filled" }] }),
    "POST /api/secrets/unlock": () => ({ ...status, state: "ready" }),
    "POST /api/secrets/init": () => ({ ...status, state: "ready" }),
    ...extra,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      const route = routes[`${method} ${path}`];
      if (!route) return new Response(JSON.stringify({ error: "no route" }), { status: 404 });
      return new Response(JSON.stringify(route(method, body)), { status: 200 });
    }),
  );
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the Secrets page", () => {
  it("offers to set up a vault that is absent, with an optional passphrase", async () => {
    serve("absent");
    render(<SecretsPage />);
    const pass = await screen.findByLabelText(/Passphrase \(optional\)/);
    fireEvent.click(screen.getByText("Create vault"));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/secrets/init")).toBe(true));
    expect(calls.find((c) => c.path === "/api/secrets/init")!.body).toEqual({});
    expect((pass as HTMLInputElement).type).toBe("password");
  });

  it("asks for the passphrase when locked, and clears it once sent", async () => {
    serve("locked");
    render(<SecretsPage />);
    const pass = (await screen.findByLabelText(/^Passphrase/)) as HTMLInputElement;
    fireEvent.change(pass, { target: { value: "correct horse" } });
    fireEvent.click(screen.getByText("Unlock"));
    await waitFor(() => expect(calls.find((c) => c.path === "/api/secrets/unlock")?.body).toEqual({ passphrase: "correct horse" }));
    expect(pass.value).toBe("");
  });

  it("lists each secret by label, kind, hint, where and when, with the leak counter", async () => {
    serve("ready");
    render(<SecretsPage />);
    expect(await screen.findByText("GitHub")).toBeTruthy();
    expect(screen.getByText("Login")).toBeTruthy();
    expect(screen.getByText("github.com")).toBeTruthy();
    expect(screen.getAllByText("Used 2h ago")).toHaveLength(2);
    expect(screen.getByText("From env")).toBeTruthy();
    expect(screen.getByText("3 times")).toBeTruthy();
  });

  it("never draws a value from a GET, and opens an edit with every value field blank", async () => {
    serve("ready");
    render(<SecretsPage />);
    fireEvent.click(await screen.findByText("GitHub"));
    await screen.findByText("Remembered sites");
    expect(document.body.innerHTML).not.toContain("hunter2");
    const fields = Array.from(document.querySelectorAll<HTMLInputElement>("[data-secret]"));
    expect(fields.length).toBeGreaterThan(0);
    for (const f of fields) expect(f.value).toBe("");
    expect((screen.getByLabelText(/^Password/) as HTMLInputElement).placeholder).toBe("Unchanged (••••••)");
  });

  it("sends only what was typed on a save, blank meaning unchanged", async () => {
    serve("ready", { "PATCH /api/secrets/github-login-9xq1": () => login });
    render(<SecretsPage />);
    fireEvent.click(await screen.findByText("GitHub"));
    const pw = (await screen.findByLabelText(/^Password/)) as HTMLInputElement;
    fireEvent.change(pw, { target: { value: "n3w-pass" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const sent = calls.find((c) => c.method === "PATCH")!.body as { values: unknown; policy: { grants: unknown[] } };
    expect(sent.values).toEqual({ password: "n3w-pass" });
    expect(sent.policy.grants).toHaveLength(1);
    expect(pw.value).toBe("");
  });

  it("revokes a remembered site and lists the uses", async () => {
    serve("ready", { "DELETE /api/secrets/github-login-9xq1/grants/https%3A%2F%2Fgithub.com": () => ({ ...login, policy: { ...login.policy, grants: [] } }) });
    render(<SecretsPage />);
    fireEvent.click(await screen.findByText("GitHub"));
    expect(await screen.findByText("filled")).toBeTruthy();
    fireEvent.click(screen.getByText("Revoke"));
    expect(await screen.findByText(/None yet/)).toBeTruthy();
  });

  it("shows an env secret read-only", async () => {
    serve("ready");
    render(<SecretsPage />);
    fireEvent.click(await screen.findByText("OpenAI"));
    expect(await screen.findByText(/cannot be edited here/)).toBeTruthy();
    expect(screen.queryByText("Save")).toBeNull();
    expect((screen.getByLabelText(/^Token/) as HTMLInputElement).disabled).toBe(true);
  });

  it("asks before deleting, in the page", async () => {
    serve("ready", { "DELETE /api/secrets/github-login-9xq1": () => ({ ok: true }) });
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    render(<SecretsPage />);
    fireEvent.click(await screen.findByText("GitHub"));
    fireEvent.click(await screen.findByText("Delete"));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    const pop = await screen.findByRole("alertdialog");
    fireEvent.click(pop.querySelector(".btn--danger")!);
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/secrets/github-login-9xq1")).toBe(true));
    expect(confirm).not.toHaveBeenCalled();
  });

  it("wipes only once wipe is typed", async () => {
    serve("ready", { "POST /api/secrets/wipe": () => ({ state: "absent", slots: [], scrubbed: 0 }) });
    render(<SecretsPage />);
    fireEvent.click(await screen.findByText("Wipe vault"));
    const go = screen.getByText("Wipe everything") as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Type wipe to confirm"), { target: { value: "wipe" } });
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() => expect(calls.find((c) => c.path === "/api/secrets/wipe")?.body).toEqual({ confirm: "wipe" }));
  });

  it("reveals after the label is typed, for 30 seconds, then clears it", async () => {
    serve("ready", { "POST /api/secrets/github-login-9xq1/reveal": () => ({ value: "hunter2" }) });
    render(<SecretsPage />);
    fireEvent.click(await screen.findByText("GitHub"));
    const proof = (await screen.findByLabelText(/Type “GitHub” to confirm/)) as HTMLInputElement;
    fireEvent.change(proof, { target: { value: "GitHub" } });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(calls.find((c) => c.path.endsWith("/reveal"))?.body).toEqual({ field: "password", label: "GitHub" });
    expect(document.querySelector(".secret-revealed-value")?.textContent).toBe("hunter2");
    expect(screen.getByText("Copy")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REVEAL_MS);
    });
    expect(document.body.innerHTML).not.toContain("hunter2");
    expect(screen.getByRole("button", { name: "Reveal" })).toBeTruthy();
  });
});
