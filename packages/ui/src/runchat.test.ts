import { describe, expect, it } from "vitest";

import { runChat } from "./runchat.js";

describe("runChat", () => {
  const crons = [{ id: 28, conversationId: "cron:28" }, { id: 4, conversationId: "agent:recap" }, { id: 9 }];
  const chats = new Set(["cron:28", "agent:recap", "c1:owner"]);

  it("finds a schedule run's thread, a blob's in the blob's, and a turn's own chat", () => {
    expect(runChat({ kind: "cron", ref: "28" }, crons, chats)).toBe("cron:28");
    expect(runChat({ kind: "cron", ref: "4" }, crons, chats)).toBe("agent:recap");
    expect(runChat({ kind: "chat", ref: "c1:owner" }, crons, chats)).toBe("c1:owner");
  });

  it("finds nothing for a chat that is gone, a job with no thread yet, or a run of KOS's own", () => {
    expect(runChat({ kind: "chat", ref: "gone:owner" }, crons, chats)).toBeUndefined();
    expect(runChat({ kind: "cron", ref: "9" }, crons, chats)).toBeUndefined();
    expect(runChat({ kind: "heartbeat", ref: "heartbeat" }, crons, chats)).toBeUndefined();
  });
});
