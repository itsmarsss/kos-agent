import { describe, expect, it } from "vitest";

import { keyCap, keyCaps, keyPlatformOf } from "./keys.js";

describe("keys as keycaps", () => {
  it("draw Meta as ⌘ on a Mac and as Ctrl elsewhere", () => {
    expect(keyCap("Meta+Minus", "mac")).toBe("⌘−");
    expect(keyCap("Meta+Minus", "other")).toBe("Ctrl+−");
    expect(keyCap("ControlOrMeta+a", "mac")).toBe("⌘A");
    expect(keyCap("cmd+s", "other")).toBe("Ctrl+S");
  });

  it("put the modifiers in Apple's order whatever order they were written in", () => {
    expect(keyCap("Shift+Meta+t", "mac")).toBe("⇧⌘T");
    expect(keyCap("meta+alt+ctrl+shift+k", "mac")).toBe("⌃⌥⇧⌘K");
    expect(keyCap("Shift+Control+Tab", "other")).toBe("Ctrl+Shift+Tab");
    // Meta and Ctrl are one cap off a Mac.
    expect(keyCap("Ctrl+Meta+x", "other")).toBe("Ctrl+X");
  });

  it("name the keys a driver spells its own way", () => {
    expect(keyCap("Enter", "mac")).toBe("⏎");
    expect(keyCap("Return", "other")).toBe("⏎");
    expect(keyCap("Meta+Home", "mac")).toBe("⌘Home");
    expect(keyCap("ArrowDown", "mac")).toBe("↓");
    expect(keyCap("Page_Down", "mac")).toBe("Page Down");
    expect(keyCap("BackSpace", "mac")).toBe("⌫");
    expect(keyCap("BackSpace", "other")).toBe("Backspace");
    expect(keyCap("Escape", "mac")).toBe("Esc");
    expect(keyCap("KeyA", "mac")).toBe("A");
    expect(keyCap("Digit7", "mac")).toBe("7");
    expect(keyCap("f5", "mac")).toBe("F5");
    expect(keyCap("Meta++", "mac")).toBe("⌘+");
    // A modifier on its own is a key.
    expect(keyCap("Shift", "mac")).toBe("⇧");
  });

  it("split a run a computer types out into chords", () => {
    expect(keyCaps("ctrl+a Delete", "mac")).toEqual(["⌃A", "⌦"]);
    expect(keyCaps("  ", "mac")).toEqual([]);
  });

  it("say a computer's keys as a Mac's, and a browser's as where it runs", () => {
    expect(keyPlatformOf("computer.act", "other")).toBe("mac");
    expect(keyPlatformOf("browser.act", "other")).toBe("other");
  });
});
