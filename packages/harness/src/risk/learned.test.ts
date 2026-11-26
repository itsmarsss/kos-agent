import { describe, expect, it } from "vitest";

import { deletesData, learnable, postsToChannel, type LearnedCall } from "./learned.js";
import type { RiskAssessment } from "./tiers.js";

const risky: RiskAssessment = { tier: "risky", escalated: false };

function call(tool: string, input: Record<string, unknown>, over: Partial<LearnedCall> = {}): LearnedCall {
  return { tool, input, assessment: risky, guest: false, secret: false, strict: false, yours: false, ...over };
}

describe("what a learned yes may cover", () => {
  it("covers routine work, by a burst or by a job's consent", () => {
    for (const kind of ["burst", "job"] as const) {
      expect(learnable(call("files.edit", { path: "skills/scan/run.mjs" }), kind)).toBe(true);
      expect(learnable(call("sql", { sql: "UPDATE books_items SET done = 1 WHERE id = 3" }), kind)).toBe(true);
      expect(learnable(call("http.fetch", { url: "https://api.ashbyhq.com/x" }), kind)).toBe(true);
      expect(learnable(call("shell.run", { command: "touch notes.md" }), kind)).toBe(true);
      expect(learnable(call("skills.run", { name: "board" }), kind)).toBe(true);
    }
  });

  it("lets a job's consent post in a channel, and never a burst", () => {
    const post = call("notify", { to: "discord:channel:42", text: "digest" }, { assessment: { ...risky, beyondAuto: "messages someone besides you" } });
    expect(learnable(post, "job")).toBe(true);
    expect(learnable(post, "burst")).toBe(false);
  });

  it("never covers a message to a person, even for a job", () => {
    const dm = call("notify", { to: "discord:user:7", text: "hi" }, { assessment: { ...risky, beyondAuto: "messages someone besides you" } });
    expect(learnable(dm, "job")).toBe(false);
    expect(learnable(dm, "burst")).toBe(false);
  });

  it("never covers what a guest's words started", () => {
    expect(learnable(call("files.edit", { path: "x" }, { guest: true }), "burst")).toBe(false);
    expect(learnable(call("notify", { to: "channel:1", text: "x" }, { guest: true }), "job")).toBe(false);
  });

  it("never covers a secret, the clipboard or what asks every time", () => {
    expect(learnable(call("http.fetch", { url: "https://x" }, { secret: true }), "burst")).toBe(false);
    expect(learnable(call("clipboard.read", {}), "burst")).toBe(false);
    expect(learnable(call("http.fetch", { url: "https://x" }, { assessment: { ...risky, asksAlways: true } }), "job")).toBe(false);
    expect(learnable(call("browser.eval", { script: "1" }, { strict: true }), "burst")).toBe(false);
  });

  it("never covers the owner's own Chrome or a device", () => {
    expect(learnable(call("browser.act", { actions: [] }, { yours: true }), "burst")).toBe(false);
    expect(learnable(call("computer.act", {}), "job")).toBe(false);
    expect(learnable(call("computer.start", {}, { assessment: { ...risky, startsSession: true } }), "burst")).toBe(false);
  });

  it("never covers a delete of the owner's data", () => {
    expect(learnable(call("files.rm", { path: "projects/books/x.md" }), "burst")).toBe(false);
    expect(learnable(call("sql", { sql: "DELETE FROM books_items WHERE id = 1" }), "job")).toBe(false);
    expect(learnable(call("sql", { sql: "DROP TABLE books_items" }), "burst")).toBe(false);
    expect(learnable(call("shell.run", { command: "rm -rf build" }, { assessment: { ...risky, beyondAuto: "deletes recursively" } }), "burst")).toBe(false);
  });

  it("never covers money or a change to KOS itself", () => {
    expect(learnable(call("mcp.shop.buy_now", {}, { assessment: { ...risky, beyondAuto: "may spend money" } }), "job")).toBe(false);
    expect(learnable(call("skills.promote", { name: "x" }, { assessment: { ...risky, beyondAuto: "makes a skill part of KOS" } }), "burst")).toBe(false);
  });
});

describe("the shapes it reads", () => {
  it("knows a delete from an update", () => {
    expect(deletesData("sql", { sql: "UPDATE t SET a = 1" })).toBe(false);
    expect(deletesData("sql", { sql: "delete from t" })).toBe(true);
    expect(deletesData("sql", { sql: "TRUNCATE t" })).toBe(true);
    expect(deletesData("files.rm", { path: "a" })).toBe(true);
    expect(deletesData("files.edit", { path: "a" })).toBe(false);
  });

  it("knows a channel from a person", () => {
    expect(postsToChannel("notify", { to: "discord:channel:1" })).toBe(true);
    expect(postsToChannel("notify", { to: "channel:1" })).toBe(true);
    expect(postsToChannel("notify", { to: "user:1" })).toBe(false);
    expect(postsToChannel("notify", { to: "discord:user:1" })).toBe(false);
    expect(postsToChannel("notify", {})).toBe(false);
    expect(postsToChannel("files.edit", { to: "channel:1" })).toBe(false);
  });
});
