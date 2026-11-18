import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Inference } from "../agent/loop.js";
import { Kernel } from "../kernel/kernel.js";
import type { ProgressEvent } from "../kernel/progress.js";
import { handleApiRequest } from "../kernel/server.js";
import type { GenerateRequest, ModelResponse } from "../models/types.js";
import { secretsRoutes } from "./routes.js";
import { needlesOf } from "./scrub.js";
import { SecretsRegistry } from "./secrets.js";
import { Vault } from "./vault.js";

/**
 * A vault value never lands where KOS keeps or shows text (design section
 * 11, the surfaces this unit covers): not a database row, a transcript, a
 * progress event, what the model is sent or a tool result, nor any GET.
 * The canaries are random, so a hit can only be a leak.
 */

const rand = (n: number): string => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => (b % 36).toString(36)).join("");
/** A Luhn-valid 16-digit card number with random digits. */
function luhnCard(): string {
  const digits = [4, ...Array.from({ length: 14 }, () => Math.floor(Math.random() * 10))];
  const sum = digits
    .slice()
    .reverse()
    .reduce((acc, d, i) => acc + (i % 2 === 0 ? (d * 2 > 9 ? d * 2 - 9 : d * 2) : d), 0);
  return [...digits, (10 - (sum % 10)) % 10].join("");
}

const step = (content: ModelResponse["content"], stopReason: ModelResponse["stopReason"] = "tool_use"): ModelResponse => ({ content, stopReason, usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" });

/** Every file under `dir`, git's objects read out by git itself (they are compressed on disk). */
function filesText(dir: string): string {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (name === ".git") continue;
      const st = statSync(path);
      if (st.isDirectory()) walk(path);
      else if (st.size < 5_000_000 && !name.endsWith(".sqlite") && !name.includes(".sqlite-")) out.push(readFileSync(path, "utf8"));
    }
  };
  walk(dir);
  try {
    out.push(execFileSync("git", ["-C", dir, "cat-file", "--batch-all-objects", "--batch"], { encoding: "utf8", timeout: 30_000, maxBuffer: 256 * 1024 * 1024 }));
  } catch {
    // No repository yet.
  }
  return out.join("\n");
}

describe("vault values never leak", () => {
  let root: string;
  let kernel: Kernel;
  let vault: Vault;
  let canaries: string[];
  let card: string;
  const requests: GenerateRequest[] = [];
  const events: ProgressEvent[] = [];
  const printed: string[] = [];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-leak-"));
    vault = new Vault({ dir: join(root, "vault") });
    await vault.init();
    const password = `pw-${rand(20)}`;
    const token = `sk_live_${rand(28)}`;
    card = luhnCard();
    vault.add({ label: "GitHub", kind: "login", values: { username: "owner", password } });
    vault.add({ label: "Stripe", kind: "apikey", values: { token }, use: { http: { hosts: ["api.stripe.com"] } } });
    vault.add({ label: "Visa", kind: "card", values: { number: card, cvc: "123" } });
    canaries = [password, token, card];

    const secrets = new SecretsRegistry();
    secrets.attachVault(vault);
    const workspace = join(root, "ws");
    let read = false;
    const inference: Inference = {
      async generate(_task, request) {
        requests.push(JSON.parse(JSON.stringify(request)) as GenerateRequest);
        // The turn reads a file that, as a page or an API might, echoes every canary; a titler or a memory pass just answers.
        if (!read && request.tools?.some((t) => t.name === "files.read")) {
          read = true;
          return step([{ type: "tool_use", id: "t1", name: "files.read", input: { path: "echo.txt" } }]);
        }
        return step([{ type: "text", text: "Read it." }], "end_turn");
      },
    };
    kernel = await Kernel.boot({ rootDir: workspace, secrets, inference, profileOverrides: { name: "Kenny", timezone: "UTC" } });
    writeFileSync(join(kernel.workspace.root, "echo.txt"), `password ${password}\ntoken ${Buffer.from(token).toString("base64")}\ncard ${card.match(/.{4}/g)!.join(" ")}\n`);
    kernel.progress.subscribe((event) => events.push(JSON.parse(JSON.stringify(event)) as ProgressEvent));
    printed.length = 0;
    for (const stream of [process.stdout, process.stderr]) {
      const write = stream.write.bind(stream);
      vi.spyOn(stream, "write").mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
        printed.push(String(chunk));
        return (write as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof stream.write);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    kernel?.close();
    requests.length = 0;
    events.length = 0;
    rmSync(root, { recursive: true, force: true });
  });

  /** Every form of every canary the scrubber looks for, and a card's digits however they are spaced. */
  const leaks = (text: string): string[] => {
    const digitsOnly = text.replace(/[ .-]/g, "");
    return canaries.filter((c) => needlesOf(c).some((form) => text.includes(form)) || (/^\d+$/.test(c) && digitsOnly.includes(c)));
  };

  it("masks a pasted value at the door and keeps every surface clean", async () => {
    const said = `my card is ${card.match(/.{4}/g)!.join(" ")} and my password is ${canaries[0]}`;
    const chat = kernel.conversations.create({ userId: kernel.profile.ownerId, channel: "dashboard" });
    const res = await kernel.handleMessage(said, { owner: true, sessionId: chat.id });

    // Baseline: the canaries are real and the scan finds them.
    expect(leaks(said)).toHaveLength(2);

    // The model was told, never shown.
    const sent = JSON.stringify(requests);
    expect(leaks(sent)).toEqual([]);
    expect(sent).toContain(`••${card.slice(-4)}]`);
    expect(sent).toContain("KOS masked it before anything kept or read it");

    // The tool result reached the model scrubbed.
    expect(sent).toMatch(/password \[secret github-[a-z0-9]{4}\.password\]/);

    // Progress events, the transcript and every text column of every table.
    expect(leaks(JSON.stringify(events))).toEqual([]);
    expect(leaks(JSON.stringify(kernel.sessions.get(res.sessionId!)))).toEqual([]);
    const db = kernel.workspace.db;
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[];
    expect(tables.length).toBeGreaterThan(10);
    for (const { name } of tables) {
      const rows = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).raw().all();
      const text = JSON.stringify(rows, (_k, v: unknown) => (Buffer.isBuffer(v) ? v.toString("utf8") : typeof v === "bigint" ? String(v) : v));
      expect({ table: name, leaks: leaks(text) }).toEqual({ table: name, leaks: [] });
    }

    // What the dashboard and the phone read.
    const messages = await handleApiRequest(kernel, { method: "GET", path: `/api/conversations/${encodeURIComponent(res.sessionId!)}/messages` });
    expect(messages.status).toBe(200);
    expect(leaks(JSON.stringify(messages.body))).toEqual([]);
    const routes = secretsRoutes({ vault, secrets: kernel.secrets, uses: kernel.secretUses, audit: () => undefined });
    for (const path of ["/api/secrets", "/api/secrets/status", `/api/secrets/${vault.list()[0]!.handle}/uses`]) {
      const got = await routes.handle({ method: "GET", path });
      expect(got?.status).toBe(200);
      expect(leaks(JSON.stringify(got?.body))).toEqual([]);
    }
    expect(kernel.secrets.scrubbed()).toBeGreaterThan(0);

    // The workspace's files (the result shelf among them) and every git object a snapshot made.
    // The planted page goes first: it stands for a site the agent read, not something KOS keeps.
    rmSync(join(kernel.workspace.root, "echo.txt"));
    await kernel.backup.ensureRepo();
    await kernel.backup.snapshot("leak test");
    expect(leaks(filesText(kernel.workspace.root))).toEqual([]);
    // Whatever KOS printed while it ran.
    expect(leaks(printed.join(""))).toEqual([]);
  });

  it("writes no value to a row whatever path it takes", () => {
    kernel.workspace.db.exec(`CREATE TABLE leak_probe (a TEXT, b TEXT)`);
    kernel.workspace.db.prepare(`INSERT INTO leak_probe (a, b) VALUES (?, ?)`).run(`x ${canaries[1]} y`, JSON.stringify({ token: canaries[1] }));
    kernel.workspace.db.prepare(`INSERT INTO leak_probe (a, b) VALUES (@a, @b)`).run({ a: canaries[0], b: Buffer.from("raw blob stays") });
    const rows = kernel.workspace.db.prepare(`SELECT a, b FROM leak_probe`).all() as { a: string; b: unknown }[];
    expect(leaks(JSON.stringify(rows))).toEqual([]);
    expect(Buffer.isBuffer(rows[1]!.b)).toBe(true);
  });
});

describe("vault values never leak while the vault is locked", () => {
  let root: string;
  let kernel: Kernel;

  afterEach(() => {
    kernel?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("masks a pasted password and key from the scrub index and a card by shape, and says the vault is locked", async () => {
    root = mkdtempSync(join(tmpdir(), "kos-leak-locked-"));
    const dir = join(root, "vault");
    const password = `pw-${rand(20)}`;
    const token = `zz_${rand(28)}`;
    const card = luhnCard();
    const open = new Vault({ dir });
    await open.init({ passphrase: "a long passphrase" });
    open.add({ label: "GitHub", kind: "login", values: { password } });
    open.add({ label: "Custom", kind: "apikey", values: { token } });
    open.add({ label: "Visa", kind: "card", values: { number: card } });
    const locked = new Vault({ dir });
    expect(locked.status().state).toBe("locked");
    const secrets = new SecretsRegistry();
    secrets.attachVault(locked);
    const requests: GenerateRequest[] = [];
    const inference: Inference = {
      async generate(_task, request) {
        requests.push(JSON.parse(JSON.stringify(request)) as GenerateRequest);
        return step([{ type: "text", text: "noted" }], "end_turn");
      },
    };
    kernel = await Kernel.boot({ rootDir: join(root, "ws"), secrets, inference, profileOverrides: { name: "Kenny", timezone: "UTC" } });
    const chat = kernel.conversations.create({ userId: kernel.profile.ownerId, channel: "dashboard" });
    const said = `pw ${password} key ${token} card ${card.match(/.{4}/g)!.join("-")}`;
    const res = await kernel.handleMessage(said, { owner: true, sessionId: chat.id });
    const canaries = [password, token, card];
    const leaks = (text: string): string[] => canaries.filter((c) => needlesOf(c).some((f) => text.includes(f)) || text.replace(/[ .-]/g, "").includes(card));
    expect(leaks(said)).toHaveLength(3);
    const sent = JSON.stringify(requests);
    expect(leaks(sent)).toEqual([]);
    expect(sent).toContain("The secrets vault is locked");
    expect(leaks(JSON.stringify(kernel.sessions.get(res.sessionId!)))).toEqual([]);
    const db = kernel.workspace.db;
    for (const { name } of db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]) {
      const text = JSON.stringify(db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).raw().all(), (_k, v: unknown) => (Buffer.isBuffer(v) ? v.toString("utf8") : typeof v === "bigint" ? String(v) : v));
      expect({ table: name, leaks: leaks(text) }).toEqual({ table: name, leaks: [] });
    }
    await kernel.backup.ensureRepo();
    await kernel.backup.snapshot("locked leak test");
    expect(leaks(filesText(kernel.workspace.root))).toEqual([]);
  }, 30_000);
});
