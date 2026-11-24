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

function serve(state: VaultStatus["state"], extra: Record<string, Route> = {}, more: Partial<VaultStatus> = {}): void {
  const status: VaultStatus = { state, slots: ["keyfile"], scrubbed: 3, ...more };
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
      try {
        return new Response(JSON.stringify(route(method, body)), { status: 200 });
      } catch (err) {
        return new Response(JSON.stringify({ error: "refused" }), { status: Number((err as Error).message) || 400 });
      }
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
    expect(screen.getByLabelText(/^Type it again/).getAttribute("autocomplete")).toBe("new-password");
    expect((pass as HTMLInputElement).type).toBe("password");
  });

  it("asks for the passphrase when locked, and clears it once sent", async () => {
    serve("locked", {}, { slots: ["passphrase"] });
    render(<SecretsPage />);
    const pass = (await screen.findByLabelText(/^Passphrase/)) as HTMLInputElement;
    fireEvent.change(pass, { target: { value: "correct horse" } });
    fireEvent.click(screen.getByText("Unlock"));
    await waitFor(() => expect(calls.find((c) => c.path === "/api/secrets/unlock")?.body).toEqual({ passphrase: "correct horse" }));
    expect(pass.value).toBe("");
  });

  it("says why a vault is not ready, and that exact masking waits for the unlock", async () => {
    serve("locked", {}, { slots: ["keyfile"], problem: "The key file is readable by others." });
    render(<SecretsPage />);
    expect(await screen.findByText("The key file is readable by others.")).toBeTruthy();
    expect(screen.getByText(/not masked word for word/)).toBeTruthy();
    expect(screen.queryByText("Unlock")).toBeNull();
  });

  it("adds a passphrase", async () => {
    serve("ready", { "POST /api/secrets/passphrase": () => ({ state: "ready", slots: ["passphrase"], scrubbed: 3 }) });
    render(<SecretsPage />);
    fireEvent.click(await screen.findByText("Add passphrase"));
    const next = screen.getByLabelText(/^Passphrase/) as HTMLInputElement;
    fireEvent.change(next, { target: { value: "long and secret" } });
    fireEvent.change(screen.getByLabelText(/^Type it again/), { target: { value: "long and secrt" } });
    fireEvent.click(screen.getByText("Set passphrase"));
    expect(await screen.findByText(/do not match/)).toBeTruthy();
    expect(calls.some((c) => c.path === "/api/secrets/passphrase")).toBe(false);
    expect(next.value).toBe("long and secret");
    fireEvent.change(screen.getByLabelText(/^Type it again/), { target: { value: "long and secret" } });
    fireEvent.click(screen.getByText("Set passphrase"));
    await waitFor(() => expect(calls.find((c) => c.path === "/api/secrets/passphrase")?.body).toEqual({ passphrase: "long and secret" }));
    expect(next.value).toBe("");
    expect(await screen.findByText(/Passphrase set/)).toBeTruthy();
  });

  it("removes a passphrase with the current one", async () => {
    serve("ready", { "POST /api/secrets/passphrase": () => ({ state: "ready", slots: ["keyfile"], scrubbed: 3 }) }, { slots: ["passphrase"] });
    render(<SecretsPage />);
    fireEvent.click(await screen.findByText("Change passphrase"));
    fireEvent.change(screen.getByLabelText(/^Current passphrase/), { target: { value: "old one" } });
    fireEvent.click(screen.getByText("Remove passphrase"));
    await waitFor(() => expect(calls.find((c) => c.path === "/api/secrets/passphrase")?.body).toEqual({ current: "old one" }));
  });

  it("says when the try budget is spent", async () => {
    serve("locked", {}, { slots: ["passphrase"] });
    render(<SecretsPage />);
    const pass = await screen.findByLabelText(/^Passphrase/);
    routes["POST /api/secrets/unlock"] = () => {
      throw new Error("429");
    };
    fireEvent.change(pass, { target: { value: "guess" } });
    fireEvent.click(screen.getByText("Unlock"));
    expect(await screen.findByText(/Too many tries/)).toBeTruthy();
  });

  it("lists each secret by label, kind, hint, where and when, with the leak counter", async () => {
    serve("ready");
    render(<SecretsPage />);
    expect(await screen.findByText("GitHub")).toBeTruthy();
    expect(screen.getByText("Login")).toBeTruthy();
    expect(screen.getByText("github.com")).toBeTruthy();
    expect(screen.getAllByText("Used 2h ago")).toHaveLength(2);
    expect(screen.getByText("From env")).toBeTruthy();
    expect(screen.getByText("3 times since KOS started")).toBeTruthy();
    expect(screen.getByText("On its own when KOS starts")).toBeTruthy();
    // Wipe stands apart from the routine two, said for what it does.
    expect(screen.getByText("Wipe vault").closest(".secret-vault-danger")?.textContent).toContain("every secret in it, for good");
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
    expect((screen.getByLabelText(/^Password/) as HTMLInputElement).placeholder).toBe("Unchanged");
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

  it("keeps a new value typed through a refused save, so the retry sends it and not unchanged", async () => {
    let refuse = true;
    serve("ready", {
      "PATCH /api/secrets/github-login-9xq1": () => {
        if (refuse) throw new Error("400");
        return login;
      },
    });
    render(<SecretsPage />);
    fireEvent.click(await screen.findByText("GitHub"));
    const pw = (await screen.findByLabelText(/^Password/)) as HTMLInputElement;
    fireEvent.change(pw, { target: { value: "n3w-pass" } });
    fireEvent.click(screen.getByText("Save"));
    expect(await screen.findByText("refused")).toBeTruthy();
    expect(pw.value).toBe("n3w-pass");
    refuse = false;
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(2));
    const retry = calls.filter((c) => c.method === "PATCH")[1]!.body as { values: unknown };
    expect(retry.values).toEqual({ password: "n3w-pass" });
    await waitFor(() => expect(pw.value).toBe(""));
  });

  it("saves an API key's hosts with bearer, as its chips show", async () => {
    serve("ready", { "POST /api/secrets": () => ({ handle: "openai-x1y2" }) });
    render(<SecretsPage />);
    fireEvent.click(await screen.findByText("New secret"));
    fireEvent.click(await screen.findByRole("button", { name: "API key" }));
    fireEvent.change(screen.getByLabelText("Label", { exact: false }), { target: { value: "OpenAI" } });
    fireEvent.change(screen.getByLabelText(/^Token/), { target: { value: "sk-proj-abcdefghijklmnop" } });
    const host = screen.getByLabelText("Add to API hosts");
    fireEvent.change(host, { target: { value: "api.openai.com" } });
    fireEvent.keyDown(host, { key: "Enter" });
    fireEvent.click(screen.getAllByText("Create").find((b) => b.closest(".sheet-foot"))!);
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/secrets")).toBe(true));
    const sent = calls.find((c) => c.method === "POST" && c.path === "/api/secrets")!.body as { use: { http: unknown }; values: unknown };
    expect(sent.use.http).toEqual({ hosts: ["api.openai.com"], as: "bearer" });
    expect(sent.values).toEqual({ token: "sk-proj-abcdefghijklmnop" });
  });

  it("says a taken label and an empty value under their fields, not the browser's words, and keeps Create off while the label is taken", async () => {
    serve("ready", { "POST /api/secrets": () => ({ handle: "x" }) });
    render(<SecretsPage />);
    fireEvent.click(await screen.findByText("New secret"));
    const create = (): HTMLButtonElement => screen.getAllByText("Create").find((b) => b.closest(".sheet-foot"))! as HTMLButtonElement;
    fireEvent.click(create());
    expect(await screen.findByText("Give the secret a name.")).toBeTruthy();
    expect(screen.getByText("Type the password.")).toBeTruthy();
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/secrets")).toBe(false);
    fireEvent.change(screen.getByLabelText("Label", { exact: false }), { target: { value: "github " } });
    expect(screen.getByText("There is already a secret called “GitHub”. Pick another name.")).toBeTruthy();
    expect(create().disabled).toBe(true);
  });

  it("puts the server's refusal of a label on the Label field", async () => {
    routes = {};
    serve("ready");
    vi.mocked(fetch).mockImplementation(async (path, init) => {
      const method = init?.method ?? "GET";
      calls.push({ method, path: String(path), body: undefined });
      if (method === "POST" && path === "/api/secrets") return new Response(JSON.stringify({ error: "Keep it to 80 characters; this is 90.", field: "label", problem: "too_long" }), { status: 400 });
      const route = routes[`${method} ${String(path)}`];
      return route ? new Response(JSON.stringify(route(method, undefined))) : new Response("{}", { status: 404 });
    });
    render(<SecretsPage />);
    fireEvent.click(await screen.findByText("New secret"));
    fireEvent.change(screen.getByLabelText("Label", { exact: false }), { target: { value: "Work laptop" } });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: "pw" } });
    fireEvent.click(screen.getAllByText("Create").find((b) => b.closest(".sheet-foot"))!);
    const said = await screen.findByText("Keep it to 80 characters; this is 90.");
    expect(said.closest("[data-field]")?.getAttribute("data-field")).toBe("Label");
  });

  it("warns of an API key with no host, and offers no per-site ask for it", async () => {
    serve("ready");
    render(<SecretsPage />);
    fireEvent.click(await screen.findByText("New secret"));
    fireEvent.click(await screen.findByRole("button", { name: "API key" }));
    expect(screen.getByText(/With no host, KOS can't send this key anywhere/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Once per site" })).toBeNull();
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

  it("wipes only once wipe is typed, with the passphrase when there is one", async () => {
    serve("ready", { "POST /api/secrets/wipe": () => ({ state: "absent", slots: [], scrubbed: 0 }) }, { slots: ["passphrase"] });
    render(<SecretsPage />);
    fireEvent.click(await screen.findByText("Wipe vault"));
    const go = screen.getByText("Wipe everything") as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Type wipe to confirm"), { target: { value: "wipe" } });
    fireEvent.change(screen.getByLabelText(/^Passphrase/), { target: { value: "long and secret" } });
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() => expect(calls.find((c) => c.path === "/api/secrets/wipe")?.body).toEqual({ confirm: "wipe", passphrase: "long and secret" }));
  });

  it("reveals after the label is typed, for 30 seconds, then clears it, never onto the clipboard", async () => {
    serve("ready", { "POST /api/secrets/github-login-9xq1/reveal": () => ({ value: "hunter2" }) });
    const writes = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: writes, write: writes }, configurable: true });
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
    // A page can only write plain text to the clipboard, which history apps keep: a secret's value is never offered there.
    expect(screen.queryByText("Copy")).toBeNull();
    expect(screen.getByText(/Hidden in 30s/)).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REVEAL_MS);
    });
    expect(document.body.innerHTML).not.toContain("hunter2");
    expect(screen.getByRole("button", { name: "Reveal" })).toBeTruthy();
    expect(writes).not.toHaveBeenCalled();
  });
});

describe("unlock at login with KOS for Mac", () => {
  it("is offered beside a passphrase when KOS for Mac runs here, and adds the slot", async () => {
    const on: VaultStatus = { state: "ready", slots: ["passphrase", "device"], devices: [{ id: "s2", name: "Studio Mac" }], scrubbed: 3, mac: { name: "Studio Mac" } };
    serve("ready", { "POST /api/secrets/devices": () => on }, { slots: ["passphrase"], mac: { name: "Studio Mac" } });
    render(<SecretsPage />);
    fireEvent.click(await screen.findByText("Unlock at login with KOS for Mac"));
    const pass = (await screen.findByLabelText(/^Passphrase/)) as HTMLInputElement;
    fireEvent.change(pass, { target: { value: "a long passphrase" } });
    fireEvent.submit(pass.form!);
    await waitFor(() => expect(calls.find((c) => c.method === "POST" && c.path === "/api/secrets/devices")?.body).toEqual({ passphrase: "a long passphrase" }));
    expect(await screen.findByText("KOS for Mac now opens the vault at login.")).toBeTruthy();
  });

  it("says why it cannot be turned on: no passphrase, or no Mac here", async () => {
    serve("ready", {}, { slots: ["keyfile"], mac: { name: "Studio Mac" } });
    render(<SecretsPage />);
    const button = (await screen.findByText("Unlock at login with KOS for Mac")) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/Set a passphrase first/)).toBeTruthy();
    cleanup();
    serve("ready", {}, { slots: ["passphrase"], mac: { reason: "KOS for Mac is not running on this computer" } });
    render(<SecretsPage />);
    expect(((await screen.findByText("Unlock at login with KOS for Mac")) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("KOS for Mac is not running on this computer")).toBeTruthy();
  });

  it("shows the Mac that opens it, and turns it off with the passphrase", async () => {
    const off: VaultStatus = { state: "ready", slots: ["passphrase"], scrubbed: 3, mac: { name: "Studio Mac" } };
    serve("ready", { "POST /api/secrets/devices/remove": () => off }, { slots: ["passphrase", "device"], devices: [{ id: "s2", name: "Studio Mac" }], mac: { name: "Studio Mac" } });
    render(<SecretsPage />);
    expect(await screen.findByText("At login, by KOS for Mac on Studio Mac; the passphrase is the way back in")).toBeTruthy();
    expect(screen.queryByText("Remove passphrase")).toBeNull();
    fireEvent.click(screen.getByText("Turn off"));
    const pass = (await screen.findByLabelText(/^Passphrase/)) as HTMLInputElement;
    fireEvent.change(pass, { target: { value: "a long passphrase" } });
    fireEvent.submit(pass.form!);
    await waitFor(() => expect(calls.find((c) => c.path === "/api/secrets/devices/remove")?.body).toEqual({ slot: "s2", passphrase: "a long passphrase" }));
  });

  it("says when the vault is locked that the Mac opens it, and why it did not", async () => {
    serve("locked", {}, { slots: ["passphrase", "device"], devices: [{ id: "s2", name: "Studio Mac" }], atLogin: "KOS for Mac did not open the vault (Studio Mac: the device is offline); the passphrase still opens it" });
    render(<SecretsPage />);
    expect(await screen.findByText(/KOS for Mac on Studio Mac opens the vault when it connects/)).toBeTruthy();
    expect(screen.getByText(/the device is offline/)).toBeTruthy();
    expect(screen.getByLabelText(/^Passphrase/)).toBeTruthy();
  });
});
