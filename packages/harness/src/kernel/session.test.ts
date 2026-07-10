import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { SessionStore } from "./session.js";

describe("SessionStore", () => {
  let root: string;
  let ws: Workspace;
  let sessions: SessionStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-session-"));
    ws = Workspace.open(root);
    sessions = new SessionStore(ws.db, { maxMessages: 4 });
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("starts empty and appends compact turns", () => {
    expect(sessions.get("cli:owner")).toEqual([]);
    sessions.appendTurn("cli:owner", "hello", [
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ]);
    const hist = sessions.get("cli:owner");
    expect(hist).toHaveLength(2);
    expect(hist[0]?.role).toBe("user");
    expect(hist[1]?.role).toBe("assistant");
  });

  it("truncates to maxMessages", () => {
    for (let i = 0; i < 5; i++) {
      sessions.appendTurn(`s`, `u${i}`, [
        { role: "assistant", content: [{ type: "text", text: `a${i}` }] },
      ]);
    }
    expect(sessions.get("s").length).toBeLessThanOrEqual(4);
  });

  it("clears a session", () => {
    sessions.appendTurn("x", "a", [
      { role: "assistant", content: [{ type: "text", text: "b" }] },
    ]);
    sessions.clear("x");
    expect(sessions.get("x")).toEqual([]);
  });
});
