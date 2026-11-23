import { describe, expect, it } from "vitest";

import { askView, DETACHED_WORDS } from "./ask.js";
import { clockWords } from "./chattime.js";
import { decidedWords, typedVia } from "./decided.js";

const NOW = Date.UTC(2026, 10, 23, 22, 0);
const AT = NOW - 60 * 60_000;
const asked = AT - 30 * 60_000;

describe("decidedWords", () => {
  it("says where a yes or a no was pressed, and when", () => {
    expect(decidedWords({ status: "approved", decidedVia: "discord", decidedAt: AT, requestedAt: asked }, NOW)).toBe(`Approved on Discord, ${clockWords(AT)}`);
    expect(decidedWords({ status: "denied", decidedVia: "dashboard", decidedAt: AT, requestedAt: asked }, NOW)).toBe(`Denied on the dashboard, ${clockWords(AT)}`);
    expect(decidedWords({ status: "approved", decidedVia: typedVia("sms"), decidedAt: AT, requestedAt: asked }, NOW)).toBe(`Approved by a typed command on SMS, ${clockWords(AT)}`);
    expect(decidedWords({ status: "approved", decidedVia: "auto", decidedAt: AT, requestedAt: AT }, NOW)).toBe(`Approved by Auto mode, ${clockWords(AT)}`);
    expect(decidedWords({ status: "approved", decidedVia: "rule", decidedAt: AT, requestedAt: AT }, NOW)).toBe(`Approved by a remembered rule, ${clockWords(AT)}`);
  });

  it("says why an ask lapsed, and how long nobody decided", () => {
    expect(decidedWords({ status: "expired", decidedVia: "timeout", decidedAt: AT, requestedAt: asked }, NOW)).toBe("Lapsed: nobody decided in 30 minutes");
    expect(decidedWords({ status: "expired", decidedVia: "timeout", decidedAt: AT, requestedAt: AT - 24 * 3_600_000 }, NOW)).toBe("Lapsed: nobody decided in 24 hours");
    expect(decidedWords({ status: "expired", decidedVia: "turn-gone", decidedAt: AT, requestedAt: asked }, NOW)).toBe("Lapsed: its chat stopped before you decided");
    expect(decidedWords({ status: "expired", decidedVia: "restart", decidedAt: AT, requestedAt: asked }, NOW)).toBe("Lapsed: its chat stopped before you decided, when KOS restarted");
    expect(decidedWords({ status: "expired", decidedVia: "kill-switch", decidedAt: AT, requestedAt: asked }, NOW)).toBe("Lapsed: the kill switch was thrown");
    expect(decidedWords({ status: "expired", decidedVia: "chat-deleted", decidedAt: AT, requestedAt: asked }, NOW)).toBe("Lapsed: its chat was deleted");
  });

  it("reads a row from before this was kept as unknown", () => {
    expect(decidedWords({ status: "approved", decidedVia: null, decidedAt: AT, requestedAt: asked }, NOW)).toBe(`Approved, ${clockWords(AT)}; where is unknown`);
    expect(decidedWords({ status: "expired", decidedVia: null, decidedAt: null, requestedAt: asked }, NOW)).toBe("Lapsed; why is unknown");
  });
});

describe("a detached ask's card", () => {
  it("warns before any yes that no turn waits on the result", () => {
    expect(askView({ tool: "sql", args: { sql: "DELETE FROM t" }, detached: "stopped" }).detached).toBe(DETACHED_WORDS.stopped);
    expect(askView({ tool: "sql", args: { sql: "DELETE FROM t" }, detached: "unwaited" }).detached).toBe(DETACHED_WORDS.unwaited);
    expect(askView({ tool: "sql", args: { sql: "DELETE FROM t" } }).detached).toBeUndefined();
  });
});
