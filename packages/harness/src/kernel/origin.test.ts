import { describe, expect, it } from "vitest";

import { originOf } from "./origin.js";

describe("where a message came from", () => {
  it("is nothing for the owner typing on the dashboard", () => {
    expect(originOf({})).toBeUndefined();
    expect(originOf({ channel: "dashboard" })).toBeUndefined();
  });

  it("names the surface and the room", () => {
    expect(originOf({ channel: "discord", room: { kind: "channel", id: "c1", name: "leetcode" } })).toEqual({ via: "discord", room: { kind: "channel", id: "c1", name: "leetcode" } });
    expect(originOf({ channel: "imessage" })).toEqual({ via: "imessage" });
  });

  it("names a guest, the schedule that fired, and the chat that sent it", () => {
    expect(originOf({ channel: "discord", room: { kind: "channel", name: "leetcode" }, guest: { id: "u2", name: "Ana" } })).toEqual({
      via: "discord",
      room: { kind: "channel", name: "leetcode" },
      from: { kind: "guest", name: "Ana", id: "u2" },
    });
    expect(originOf({ via: "schedule", from: { kind: "schedule", name: "Daily board", id: "18" } })).toEqual({ via: "schedule", from: { kind: "schedule", name: "Daily board", id: "18" } });
    expect(originOf({ channel: "dispatch", from: { kind: "chat", name: "Workout Tracker", id: "project:workout_tracker" } })).toEqual({
      via: "dispatch",
      from: { kind: "chat", name: "Workout Tracker", id: "project:workout_tracker" },
    });
  });
});
