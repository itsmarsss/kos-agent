import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SearchHit, SearchResults } from "@kos/shared";

import type { Inference } from "../agent/loop.js";
import { writePage } from "../memory/pages.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Vault } from "../secrets/vault.js";
import { Kernel } from "./kernel.js";
import { searchAll, type SearchSource } from "./search.js";
import { handleApiRequest } from "./server.js";

const stub: Inference = {
  async generate() {
    return { content: [{ type: "text", text: "hi" }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" };
  },
};

/** A value no hit may ever carry. */
const CANARY = "pw-marigold-canary-9931";

describe("GET /api/search", () => {
  let root: string;
  let outside: string;
  let kernel: Kernel;
  let vaultDir: string;

  const search = async (q: string, kinds?: string): Promise<SearchResults> => {
    const url = `/api/search?${new URLSearchParams({ q, ...(kinds ? { kinds } : {}) })}`;
    const res = await handleApiRequest(kernel, { method: "GET", path: "/api/search", url });
    expect(res.status).toBe(200);
    return res.body as SearchResults;
  };
  const shown = (hit: SearchHit): string[] => hit.snippet.marks.map(([s, e]) => hit.snippet.text.slice(s, e));

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "kos-search-")));
    outside = realpathSync(mkdtempSync(join(tmpdir(), "kos-search-out-")));
    vaultDir = join(outside, "vault");
    const vault = new Vault({ dir: vaultDir });
    await vault.init({});
    vault.add({ label: "Marigold nursery", kind: "login", values: { username: "owner", password: CANARY }, use: { web: { origins: ["https://marigold.example"] } } });
    const secrets = SecretsRegistry.fromEnv({ KOS_SECRET_MARIGOLD_API: `env-${CANARY}` } as NodeJS.ProcessEnv);
    secrets.attachVault(vault);
    kernel = await Kernel.boot({ rootDir: root, secrets, inference: stub, chrome: { port: 1, exists: () => false } });
  });

  afterEach(() => {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("answers nothing for a query too short to mean anything", async () => {
    expect(await search("m")).toEqual({ hits: [], late: [], truncated: [] });
  });

  it("finds a message and opens the chat at the entry its view draws", async () => {
    const chat = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Garden" });
    kernel.sessions.set(chat.id, [
      { role: "user", content: [{ type: "text", text: "When do I plant the marigolds?" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "memory.recall", input: { query: "garden" } }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "[]", isError: false }] },
      { role: "assistant", content: [{ type: "text", text: "Plant **marigolds** after the last frost." }] },
    ]);
    const { hits } = await search("marigolds", "msg");
    expect(hits.every((h) => h.target.kind === "chat" && h.target.id === chat.id)).toBe(true);
    expect(new Set(hits.map((h) => (h.target as { event: number }).event))).toEqual(new Set([0, 2]));
    // The index is the view's: the same entry the chat's transcript holds there.
    const view = (await handleApiRequest(kernel, { method: "GET", path: `/api/conversations/${encodeURIComponent(chat.id)}/messages` })).body as { events: { kind: string; text?: string }[] };
    for (const hit of hits) expect(view.events[(hit.target as { event: number }).event]?.text).toMatch(/marigolds/);
    expect(hits.every((h) => h.title === "Garden" && shown(h).every((m) => m.toLowerCase() === "marigolds"))).toBe(true);
  });

  it("finds a message whatever its case, and one a first pass cannot narrow by", async () => {
    const chat = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Trip" });
    kernel.sessions.set(chat.id, [{ role: "user", content: [{ type: "text", text: "Book the CAFÉ in Montréal" }] }]);
    expect((await search("montréal", "msg")).hits).toHaveLength(1);
    expect((await search("café montréal", "msg")).hits[0]?.snippet.text).toBe("Book the CAFÉ in Montréal");
  });

  it("reads files through the jail: no workspace files of KOS's own, no .kos, no hidden file, no link out", async () => {
    mkdirSync(join(root, "projects/garden"), { recursive: true });
    writeFileSync(join(root, "projects/garden/plan.md"), "# Plan\n\nSow marigold seeds in March.\n");
    writeFileSync(join(root, "projects/garden/.env"), "MARIGOLD=1");
    writeFileSync(join(root, "profile.json"), JSON.stringify({ note: "marigold" }));
    mkdirSync(join(root, ".kos"), { recursive: true });
    writeFileSync(join(root, ".kos/log.md"), "marigold");
    writeFileSync(join(outside, "elsewhere.md"), "marigold");
    symlinkSync(outside, join(root, "projects/garden/out"));
    const { hits } = await search("marigold", "text");
    expect(hits.map((h) => h.target)).toEqual([{ kind: "file", path: "projects/garden/plan.md", line: 3 }]);
    expect(hits[0]).toMatchObject({ kind: "text", title: "projects/garden/plan.md", hint: "line 3" });
    expect(shown(hits[0]!)).toEqual(["marigold"]);
  });

  it("finds claims and memory pages, and leaves a page's file to memory", async () => {
    const claim = kernel.facts.upsert(kernel.profile.ownerId, { key: "garden.flowers", value: "The owner grows marigolds by the fence", kind: "fact" }, "test");
    writePage(kernel.workspace, "garden", "# Garden\n\n- garden.flowers: marigolds by the fence\n");
    const { hits } = await search("marigolds");
    const memory = hits.filter((h) => h.kind === "memory");
    expect(memory.map((h) => h.target)).toEqual(expect.arrayContaining([{ kind: "claim", id: claim.id }, { kind: "memory-page", name: "garden" }]));
    expect(hits.some((h) => h.kind === "text" && h.title === "memory/garden.md")).toBe(false);
    expect(memory.find((h) => h.target.kind === "claim")).toMatchObject({ title: "Garden.flowers", hint: "for every chat" });
  });

  it("finds runs by their job's name or error, and tool calls by what they were given", async () => {
    const job = kernel.crons.create({ name: "Marigold watering", schedule: "0 7 * * *", type: "self_prompt", prompt: "water", enabled: true });
    const run = kernel.runs.start("cron", String(job.id));
    kernel.runs.finish(run, "error", "pump offline");
    const call = kernel.audit.record({ tool: "files.write", args: { path: "projects/garden/marigold-log.md" }, result: "ok", isError: false });
    expect((await search("marigold watering", "run")).hits.map((h) => h.target)).toEqual([{ kind: "run", id: run }]);
    expect((await search("pump offline", "run")).hits[0]).toMatchObject({ title: "Marigold watering", hint: "Schedule run, failed", snippet: { text: "pump offline" } });
    // A step by what it did, never its tool's name.
    expect((await search("marigold-log", "run")).hits).toMatchObject([{ target: { kind: "call", id: call }, title: "Write a file", hint: "Step" }]);
  });

  it("names secrets and never says what they hold", async () => {
    const { hits } = await search("marigold", "secret");
    expect(hits.map((h) => h.title).sort()).toEqual(["Marigold nursery", "marigold_api"]);
    expect(hits.find((h) => h.title === "Marigold nursery")?.target).toMatchObject({ kind: "secret" });
    expect(JSON.stringify(await search("marigold"))).not.toContain(CANARY);
    // Asked for by what it holds, it is not found at all.
    expect((await search(CANARY)).hits).toEqual([]);
  });

  it("lists only the env file's names while the vault is locked", async () => {
    const shut = new Vault({ dir: join(outside, "locked") });
    await shut.init({ passphrase: "a long vault passphrase" });
    shut.add({ label: "Marigold bank", kind: "login", values: { username: "o", password: CANARY } });
    kernel.secrets.attachVault(new Vault({ dir: join(outside, "locked") }));
    expect((await search("marigold", "secret")).hits.map((h) => h.title)).toEqual(["marigold_api"]);
  }, 20_000);

  it("ranks across kinds and narrows to the kinds asked for", async () => {
    const chat = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Notes" });
    kernel.sessions.set(chat.id, [{ role: "user", content: [{ type: "text", text: "marigold" }] }]);
    kernel.facts.upsert(kernel.profile.ownerId, { key: "marigold", value: "a flower", kind: "fact" }, "test");
    const all = await search("marigold");
    expect(new Set(all.hits.map((h) => h.kind))).toEqual(new Set(["msg", "memory", "secret"]));
    expect([...all.hits].sort((a, b) => b.score - a.score)).toEqual(all.hits);
    expect(new Set((await search("marigold", "memory,nonsense")).hits.map((h) => h.kind))).toEqual(new Set(["memory"]));
  });
});

describe("searchAll", () => {
  const hit = (id: string, score: number): SearchHit => ({ kind: "msg", id, title: id, snippet: { text: id, marks: [] }, score, target: { kind: "chat", id, event: 0 } });

  it("answers by its deadline with what came, names the late, and stops them", async () => {
    let stopped = false;
    const slow: SearchSource = {
      kind: "text",
      find: (_q, ctx) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener("abort", () => (stopped = true));
          setTimeout(() => resolve({ hits: [hit("slow", 9)] }), 2_000);
        }),
    };
    const quick: SearchSource = { kind: "msg", find: () => ({ hits: [hit("a", 0.5), hit("b", 0.9)] }) };
    const began = Date.now();
    const got = await searchAll([slow, quick], "marigold", { deadlineMs: 120 });
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(got.hits.map((h) => h.id)).toEqual(["b", "a"]);
    expect(got.late).toEqual(["text"]);
    expect(stopped).toBe(true);
  });

  it("caps each source, says so, and keeps a failing source from failing the rest", async () => {
    const many: SearchSource = { kind: "msg", find: () => ({ hits: Array.from({ length: 12 }, (_, i) => hit(`m${i}`, 1 - i / 100)) }) };
    const broken: SearchSource = { kind: "memory", find: () => { throw new Error("no store"); } };
    const got = await searchAll([many, broken], "marigold", { perSource: 3 });
    expect(got.hits.map((h) => h.id)).toEqual(["m0", "m1", "m2"]);
    expect(got.truncated).toEqual(["msg"]);
    expect(got.late).toEqual([]);
  });
});
