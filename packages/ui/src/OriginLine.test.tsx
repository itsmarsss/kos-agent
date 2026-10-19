import { describe, expect, it } from "vitest";

import { originWords } from "./OriginLine.js";

describe("where a message came from, in words", () => {
  it("names the surface and the room", () => {
    expect(originWords({ via: "discord", room: { kind: "channel", name: "leetcode" } })).toEqual({ text: "via #leetcode on Discord" });
    expect(originWords({ via: "discord", room: { kind: "thread", name: "Seeds" } })).toEqual({ text: "via thread Seeds on Discord" });
    expect(originWords({ via: "discord", room: { kind: "dm" } })).toEqual({ text: "via Discord DM" });
    expect(originWords({ via: "imessage" })).toEqual({ text: "via iMessage" });
    expect(originWords({ via: "sms" })).toEqual({ text: "via SMS" });
  });

  it("names a guest, a schedule with its page, and the chat that sent it", () => {
    expect(originWords({ via: "discord", room: { kind: "channel", name: "leetcode" }, from: { kind: "guest", name: "Ana" } })).toEqual({ text: "Ana, a guest in #leetcode on Discord" });
    expect(originWords({ via: "schedule", from: { kind: "schedule", name: "Daily board", id: "18" } })).toEqual({ text: "schedule · Daily board", href: "#/schedule/18" });
    expect(originWords({ via: "dispatch", from: { kind: "chat", name: "Workout Tracker", id: "project:workout_tracker" } })).toEqual({ text: "sent by Workout Tracker", href: "#/chats/project%3Aworkout_tracker" });
  });

  it("says nothing for the dashboard, or a dispatch with no sender", () => {
    expect(originWords({ via: "dashboard" })).toBeNull();
    expect(originWords({ via: "dispatch" })).toBeNull();
  });
});
