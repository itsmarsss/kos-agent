// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { OriginLine, originWords } from "./OriginLine.js";

describe("where a message came from, in words", () => {
  it("names the surface and the room", () => {
    expect(originWords({ via: "discord", room: { kind: "channel", name: "leetcode" } })).toEqual({ text: "via #leetcode on Discord", room: "#leetcode" });
    expect(originWords({ via: "discord", room: { kind: "thread", name: "Seeds" } })).toEqual({ text: "via thread Seeds on Discord", room: "thread Seeds" });
    expect(originWords({ via: "discord", room: { kind: "dm" } })).toEqual({ text: "via Discord DM" });
    expect(originWords({ via: "imessage" })).toEqual({ text: "via iMessage" });
    expect(originWords({ via: "sms" })).toEqual({ text: "via SMS" });
  });

  it("names a guest, a schedule with its page, and the chat that sent it", () => {
    expect(originWords({ via: "discord", room: { kind: "channel", name: "leetcode" }, from: { kind: "guest", name: "Ana" } })).toEqual({ text: "Ana, a guest in #leetcode on Discord", room: "#leetcode" });
    expect(originWords({ via: "schedule", from: { kind: "schedule", name: "Daily board", id: "18" } })).toEqual({ text: "schedule · Daily board", href: "#/schedule/18" });
    expect(originWords({ via: "dispatch", from: { kind: "chat", name: "Workout Tracker", id: "project:workout_tracker" } })).toEqual({ text: "sent by Workout Tracker", href: "#/chats/project%3Aworkout_tracker" });
  });

  it("says nothing for the dashboard, or a dispatch with no sender", () => {
    expect(originWords({ via: "dashboard" })).toBeNull();
    expect(originWords({ via: "dispatch" })).toBeNull();
  });
});

describe("the line under a bubble", () => {
  it("links the channel it names when the page knows where it is, and leaves the rest as words", () => {
    const { container } = render(
      <OriginLine origin={{ via: "discord", room: { kind: "channel", name: "verity" } }} linkFor={(r) => (r.name === "verity" ? "https://discord.com/channels/g/c1" : undefined)} />,
    );
    const line = container.querySelector(".turn-via")!;
    expect(line.textContent).toBe("via #verity on Discord");
    const link = line.querySelector("a")!;
    expect(link.textContent).toBe("#verity");
    expect(link.getAttribute("href")).toBe("https://discord.com/channels/g/c1");
    // Unknown channel: words only.
    const { container: plain } = render(<OriginLine origin={{ via: "discord", room: { kind: "channel", name: "elsewhere" } }} linkFor={() => undefined} />);
    expect(plain.querySelector(".turn-via a")).toBeNull();
    expect(plain.querySelector(".turn-via")?.textContent).toBe("via #elsewhere on Discord");
  });

  it("links a thread by its id, so 'via thread X' opens the thread on Discord", () => {
    const { container } = render(
      <OriginLine
        origin={{ via: "discord", room: { kind: "thread", id: "t9", name: "School Tables" } }}
        linkFor={(r) => (r.kind === "thread" && r.id ? `https://discord.com/channels/g/${r.id}` : undefined)}
      />,
    );
    const line = container.querySelector(".turn-via")!;
    expect(line.textContent).toBe("via thread School Tables on Discord");
    const link = line.querySelector("a")!;
    expect(link.textContent).toBe("thread School Tables");
    expect(link.getAttribute("href")).toBe("https://discord.com/channels/g/t9");
  });
});
