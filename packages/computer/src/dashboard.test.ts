import { describe, expect, it } from "vitest";

import type { ApiRequest, ApiResponse, ApprovalDecision, AuditEntry } from "@kos/harness";

import { ARTIFACT_DOCUMENT_BYTES } from "./artifacts.js";
import { DASHBOARD_IN_FLIGHT, DashboardRelay, admit } from "./dashboard.js";

/**
 * A phone asking the dashboard's own routes: the reads listed and the named
 * actions go through, as the dashboard's handler would be asked them; every
 * other route, a path that could mean something else, a query key the route
 * does not take and a body that is not exactly the action's are refused
 * before the handler hears of them.
 */

const NOT_ALLOWED = { refused: "A phone cannot ask the dashboard for that." };
const BAD_QUERY = { refused: "That asks the page for something it does not take." };
const BAD_BODY = { refused: "That is not what that action takes." };
const OUTSIDE = { refused: "That file is not in the workspace." };

const get = (path: string, query?: Record<string, unknown>) => admit({ call: 1, method: "GET", path, ...(query ? { query } : {}) });
const post = (path: string, body?: unknown) => admit({ call: 1, method: "POST", path, ...(body !== undefined ? { body } : {}) });

describe("what a phone may ask the dashboard", () => {
  it("lets each listed read through, with its own query keys in the url", () => {
    for (const path of [
      "/api/home",
      "/api/inbox",
      "/api/approvals",
      "/api/approvals/history/counts",
      "/api/approvals/41",
      "/api/projects",
      "/api/projects/garden/detail",
      "/api/agents",
      "/api/crons",
      "/api/conversations/c_mx2a:owner/messages",
      "/api/conversations/project:garden/messages",
      "/api/conversations/agent:scout/messages",
      "/api/conversations/cron:1/messages",
    ]) {
      expect(get(path)).toEqual({ kind: "read", request: { method: "GET", path, url: path } });
    }
    expect(get("/api/approvals/history", { before: "1761800000000,41", status: "denied", q: "files", limit: "25" })).toMatchObject({
      request: { url: "/api/approvals/history?before=1761800000000%2C41&status=denied&q=files&limit=25" },
    });
    expect(get("/api/artifacts", { trashed: "1" })).toMatchObject({ request: { url: "/api/artifacts?trashed=1" } });
    expect(get("/api/artifacts/plan/export", { format: "pdf", theme: "dark" })).toMatchObject({ request: { url: "/api/artifacts/plan/export?format=pdf&theme=dark" } });
    expect(get("/api/artifacts/budget/export", { format: "csv", tab: "0" })).toMatchObject({ kind: "read", request: { path: "/api/artifacts/budget/export" } });
    for (const path of ["/api/files", "/api/file", "/api/file/text", "/api/file/raw", "/api/file/view"]) {
      expect(get(path, { path: "notes/garden plan.md" })).toMatchObject({ kind: "read", request: { url: `${path}?path=notes%2Fgarden+plan.md` } });
    }
    expect(get("/api/files")).toMatchObject({ request: { url: "/api/files" } });
    expect(get("/api/memory", { limit: "50" })).toMatchObject({ request: { url: "/api/memory?limit=50" } });
    expect(get("/api/memory/trace", { key: "home city" })).toMatchObject({ request: { url: "/api/memory/trace?key=home+city" } });
    expect(get("/api/runs", { limit: "20", failed: "1" })).toMatchObject({ request: { url: "/api/runs?limit=20&failed=1" } });
  });

  it("refuses every other route", () => {
    for (const path of [
      "/api/settings",
      "/api/status",
      "/api/health",
      "/api/audit",
      "/api/conversations",
      "/api/projects/garden/files",
      "/api/artifacts/plan/thumb",
      "/api/frames/3",
      "/api/approvals/41/picture",
      "/api/file/download",
      "/api/memory/log",
      "/api/devices",
      "/api/home/",
      "/home",
      "api/home",
      "",
    ]) {
      expect(get(path)).toEqual(NOT_ALLOWED);
    }
    for (const path of ["/api/files/delete", "/api/files/upload", "/api/message", "/api/kill", "/api/pages/x/write", "/api/artifacts/x/delete", "/api/artifacts/x/trash", "/api/crons/delete", "/api/memory", "/api/home"]) {
      expect(post(path, {})).toEqual(NOT_ALLOWED);
    }
    expect(admit({ method: "DELETE", path: "/api/home" })).toEqual(NOT_ALLOWED);
    expect(admit({ method: "GET", path: 7 })).toEqual(NOT_ALLOWED);
  });

  it("refuses a path that could mean anything else to the handler", () => {
    for (const path of [
      "/api/files/../settings",
      "/api/projects/../detail",
      "/api/./home",
      "/api/conversations/../../settings/messages",
      "/api/conversations/%2e%2e/messages",
      "/api/conversations/a%2Fb/messages",
      "/api/projects/garden%2Fx/detail",
      "/api//home",
      "/api/home?x=1",
      "/api/home#top",
      "/api\\home",
      "/api/home\0",
      "/api/conversations/..%2F..%2Fsettings/messages",
      `/api/conversations/${"c".repeat(161)}/messages`,
      `/api/home${"/x".repeat(300)}`,
      "/api/projects/Garden/detail",
      "/api/projects/garden-plan/detail",
      "/api/approvals/4a",
      "/api/artifacts/9plan/export",
      "/api/conversations/:owner/messages",
    ]) {
      expect(get(path)).toEqual(NOT_ALLOWED);
    }
  });

  it("refuses a file path that leaves the workspace before the handler is asked", () => {
    for (const path of ["/etc/passwd", "\\\\server\\share", "~/.ssh/id_ed25519", "C:\\Windows", "..", "../kos.db", "notes/../../secret", "notes\\..\\..\\secret", "a\0b"]) {
      expect(get("/api/file", { path })).toEqual(OUTSIDE);
    }
    expect(get("/api/file", { path: "notes/..plan.md" })).toMatchObject({ kind: "read" });
  });

  it("refuses a query key the route does not take, and one that is not a short string", () => {
    expect(get("/api/home", { path: "x" })).toEqual(BAD_QUERY);
    expect(get("/api/memory", { limit: "5", key: "x" })).toEqual(BAD_QUERY);
    expect(get("/api/runs", { limit: 5 })).toEqual(BAD_QUERY);
    expect(get("/api/files", { path: "x".repeat(1025) })).toEqual(BAD_QUERY);
    expect(admit({ method: "GET", path: "/api/files", query: ["path", "x"] })).toEqual(BAD_QUERY);
    expect(admit({ method: "GET", path: "/api/files", query: "path=x" })).toEqual(BAD_QUERY);
    expect(get("/api/files", { path: "x".repeat(1024) })).toMatchObject({ kind: "read" });
  });

  it("refuses a read with a body, and an allowed path asked with the other method", () => {
    expect(admit({ method: "GET", path: "/api/home", body: {} })).toEqual(BAD_BODY);
    expect(post("/api/inbox", {})).toEqual(NOT_ALLOWED);
    expect(get("/api/approve")).toEqual(NOT_ALLOWED);
    expect(get("/api/crons/run")).toEqual(NOT_ALLOWED);
  });

  it("lets the named actions through with exactly their bodies", () => {
    expect(post("/api/approve", { id: 41 })).toEqual({ kind: "approve", request: { method: "POST", path: "/api/approve", url: "/api/approve", body: { id: 41 } }, body: { id: 41 } });
    expect(post("/api/approve", { id: 41, remember: true })).toMatchObject({ kind: "approve", body: { id: 41, remember: true } });
    expect(post("/api/deny", { id: 41 })).toMatchObject({ kind: "deny", body: { id: 41 } });
    expect(post("/api/crons/run", { id: 3 })).toMatchObject({ kind: "action", request: { path: "/api/crons/run", body: { id: 3 } } });
    expect(post("/api/crons/enable", { id: 3, enabled: false })).toMatchObject({ kind: "action", body: { id: 3, enabled: false } });
    expect(post("/api/artifacts/plan/restore", {})).toMatchObject({ kind: "action", request: { path: "/api/artifacts/plan/restore", body: {} } });
    expect(post("/api/artifacts/plan/restore")).toMatchObject({ kind: "action", body: {} });
  });

  it("refuses an action's body with a key more, a key missing, or a key of the wrong type", () => {
    for (const [path, body] of [
      ["/api/approve", {}],
      ["/api/approve", { id: "41" }],
      ["/api/approve", { id: 4.1 }],
      ["/api/approve", { id: 41, remember: "yes" }],
      ["/api/approve", { id: 41, always: true }],
      ["/api/deny", { id: 41, remember: true }],
      ["/api/crons/run", { id: 3, prompt: "do something else" }],
      ["/api/crons/enable", { id: 3 }],
      ["/api/crons/enable", { id: 3, enabled: 1 }],
      ["/api/artifacts/plan/restore", { id: "other" }],
      ["/api/crons/run", [3]],
      ["/api/crons/run", null],
    ] as const) {
      expect(post(path, body)).toEqual(BAD_BODY);
    }
    expect(admit({ method: "POST", path: "/api/crons/run", body: { id: 3 }, query: { id: "4" } })).toEqual(BAD_QUERY);
  });
});

/** A relay over a handler that answers as told, with what it was asked, decided and audited. */
function relay(answer: (req: ApiRequest) => ApiResponse | Promise<ApiResponse> = () => ({ status: 200, body: { ok: true } }), decides = true) {
  const asked: ApiRequest[] = [];
  const decided: ApprovalDecision[] = [];
  const audited: AuditEntry[] = [];
  const replies: Record<string, unknown>[] = [];
  const door = new DashboardRelay({
    ask: async (req) => {
      asked.push(req);
      return answer(req);
    },
    decide: (d) => (decides ? Promise.resolve(void decided.push(d)).then(() => ({ outcome: d.approved ? ("approved" as const) : ("denied" as const) })) : undefined),
    audit: (e) => void audited.push(e),
  });
  const ask = (data: Record<string, unknown>, device = "dev_phone") => door.answer(device, data, async (r) => void replies.push(r));
  return { door, ask, asked, decided, audited, replies };
}

describe("a phone's asks of the dashboard, answered", () => {
  it("answers a read as the route does, its own error included, and writes no read down", async () => {
    const { ask, asked, audited, replies } = relay((req) => (req.path === "/api/approvals/9" ? { status: 404, body: { error: "no such approval" } } : { status: 200, body: { greeting: "Morning" } }));
    await ask({ call: 1, method: "GET", path: "/api/home" });
    await ask({ call: 2, method: "GET", path: "/api/approvals/9" });
    expect(replies).toEqual([
      { call: 1, status: 200, body: { greeting: "Morning" } },
      { call: 2, status: 404, body: { error: "no such approval" } },
    ]);
    // No headers, so no Origin, and nothing but what the route takes.
    expect(asked).toEqual([
      { method: "GET", path: "/api/home", url: "/api/home" },
      { method: "GET", path: "/api/approvals/9", url: "/api/approvals/9" },
    ]);
    expect(audited).toEqual([]);
  });

  it("answers bytes as base64 with their type", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const csv = Buffer.from("bed,sown\n1,May\n");
    const { ask, replies } = relay((req): ApiResponse =>
      req.path === "/api/file/raw" ? { status: 200, body: png, headers: { "content-type": "image/png", "content-length": "4" } } : { status: 200, body: csv, headers: { "content-type": "text/csv; charset=utf-8" } },
    );
    await ask({ call: 3, method: "GET", path: "/api/file/raw", query: { path: "photos/bed.png" } });
    await ask({ call: 4, method: "GET", path: "/api/artifacts/beds/export", query: { format: "csv", tab: "0" } });
    expect(replies).toEqual([
      { call: 3, status: 200, type: "image/png", data: png.toString("base64") },
      { call: 4, status: 200, type: "text/csv; charset=utf-8", data: csv.toString("base64") },
    ]);
  });

  it("refuses in words, without asking the handler, what is not allowed, and leaves an ask with no call unanswered", async () => {
    const { ask, asked, replies } = relay();
    await ask({ call: 4, method: "GET", path: "/api/settings" });
    await ask({ call: "5", method: "GET", path: "/api/home" });
    await ask({ method: "GET", path: "/api/home" });
    expect(replies).toEqual([{ call: 4, error: "A phone cannot ask the dashboard for that." }]);
    expect(asked).toEqual([]);
  });

  it("decides an approval as the phone's chat.decide does, the phone as its decider, and writes it down", async () => {
    const { ask, asked, decided, audited, replies } = relay();
    await ask({ call: 6, method: "POST", path: "/api/approve", body: { id: 41, remember: true } });
    await ask({ call: 7, method: "POST", path: "/api/deny", body: { id: 42 } });
    await ask({ call: 8, method: "POST", path: "/api/approve", body: { id: 43, remember: false } });
    expect(decided).toEqual([
      { id: "41", approved: true, deciderId: "dev_phone", remember: true },
      { id: "42", approved: false, deciderId: "dev_phone" },
      { id: "43", approved: true, deciderId: "dev_phone" },
    ]);
    expect(replies).toEqual([
      { call: 6, status: 200, body: { id: 41, approved: true, outcome: "approved" } },
      { call: 7, status: 200, body: { id: 42, approved: false, outcome: "denied" } },
      { call: 8, status: 200, body: { id: 43, approved: true, outcome: "approved" } },
    ]);
    // Never through the handler, which would decide it as the dashboard.
    expect(asked).toEqual([]);
    expect(audited.map((e) => [e.tool, e.args, e.isError])).toEqual([
      ["device.dashboard", { device: "dev_phone", method: "POST", path: "/api/approve", body: { id: 41, remember: true } }, false],
      ["device.dashboard", { device: "dev_phone", method: "POST", path: "/api/deny", body: { id: 42 } }, false],
      ["device.dashboard", { device: "dev_phone", method: "POST", path: "/api/approve", body: { id: 43, remember: false } }, false],
    ]);
  });

  it("says so when there is nothing to decide with", async () => {
    const { ask, audited, replies } = relay(undefined, false);
    await ask({ call: 9, method: "POST", path: "/api/deny", body: { id: 42 } });
    expect(replies).toEqual([{ call: 9, error: "Approvals cannot be decided from the phone right now." }]);
    expect(audited.map((e) => e.isError)).toEqual([true]);
  });

  it("runs, pauses and restores through the handler, each written down as the phone's", async () => {
    const { ask, asked, audited, replies } = relay((req) =>
      req.path === "/api/crons/run" ? { status: 404, body: { error: "no such job" } } : { status: 200, body: req.body },
    );
    await ask({ call: 10, method: "POST", path: "/api/crons/run", body: { id: 3 } });
    await ask({ call: 11, method: "POST", path: "/api/crons/enable", body: { id: 3, enabled: false } });
    await ask({ call: 12, method: "POST", path: "/api/artifacts/plan/restore", body: {} });
    expect(asked.map((r) => [r.method, r.path, r.body])).toEqual([
      ["POST", "/api/crons/run", { id: 3 }],
      ["POST", "/api/crons/enable", { id: 3, enabled: false }],
      ["POST", "/api/artifacts/plan/restore", {}],
    ]);
    expect(replies.map((r) => r["status"])).toEqual([404, 200, 200]);
    expect(audited).toEqual([
      { tool: "device.dashboard", args: { device: "dev_phone", method: "POST", path: "/api/crons/run", body: { id: 3 } }, result: '{"error":"no such job"}', isError: true },
      { tool: "device.dashboard", args: { device: "dev_phone", method: "POST", path: "/api/crons/enable", body: { id: 3, enabled: false } }, result: '{"id":3,"enabled":false}', isError: false },
      { tool: "device.dashboard", args: { device: "dev_phone", method: "POST", path: "/api/artifacts/plan/restore", body: {} }, result: "{}", isError: false },
    ]);
  });

  it("turns a throw into words, and writes a failed action down as failed", async () => {
    const { ask, audited, replies } = relay(() => {
      throw new Error("the database is locked");
    });
    await ask({ call: 13, method: "GET", path: "/api/home" });
    await ask({ call: 14, method: "POST", path: "/api/crons/run", body: { id: 3 } });
    expect(replies).toEqual([
      { call: 13, error: "the database is locked" },
      { call: 14, error: "the database is locked" },
    ]);
    expect(audited.map((e) => [e.result, e.isError])).toEqual([["the database is locked", true]]);
  });

  it("refuses an answer too big for a phone's line, bytes counted as their base64", async () => {
    const tooBig = { error: "That is too big to show on a phone. Open it on the dashboard." };
    // Under the bound as bytes, over it as base64.
    const bytes = Buffer.alloc(Math.floor((ARTIFACT_DOCUMENT_BYTES * 3) / 4) + 3);
    const { ask, replies } = relay((req) =>
      req.path === "/api/file/view" ? { status: 200, body: bytes, headers: { "content-type": "application/pdf" } } : { status: 200, body: { text: "x".repeat(ARTIFACT_DOCUMENT_BYTES) } },
    );
    await ask({ call: 15, method: "GET", path: "/api/file/view", query: { path: "big.pdf" } });
    await ask({ call: 16, method: "GET", path: "/api/file/text", query: { path: "big.txt" } });
    expect(bytes.byteLength).toBeLessThan(ARTIFACT_DOCUMENT_BYTES);
    expect(replies).toEqual([
      { call: 15, ...tooBig },
      { call: 16, ...tooBig },
    ]);
  });

  it("holds a phone to a few asks on the way at once, and each phone to its own", async () => {
    const waiting: (() => void)[] = [];
    const { ask, replies } = relay(() => new Promise((done) => waiting.push(() => done({ status: 200, body: {} }))));
    const going = Array.from({ length: DASHBOARD_IN_FLIGHT }, (_, i) => ask({ call: i, method: "GET", path: "/api/home" }));
    await ask({ call: 99, method: "GET", path: "/api/home" });
    const other = ask({ call: 100, method: "GET", path: "/api/home" }, "dev_other");
    await Promise.resolve();
    expect(replies).toEqual([{ call: 99, error: "The phone is asking for too much at once. Try again in a moment." }]);
    for (const done of waiting) done();
    await Promise.all([...going, other]);
    // Once answered, there is room again.
    const after = ask({ call: 101, method: "GET", path: "/api/home" });
    waiting.at(-1)!();
    await after;
    expect(replies.map((r) => r["call"]).sort((a, b) => Number(a) - Number(b))).toEqual([0, 1, 2, 3, 99, 100, 101]);
  });
});
