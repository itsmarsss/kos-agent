// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Face, lookOf, moodOf } from "./Face.js";

afterEach(cleanup);

describe("an agent's face", () => {
  it("is the same for the same name, within range, and differs between names", () => {
    const a = lookOf("price-watch");
    expect(lookOf("Price-Watch ")).toEqual(a);
    expect(a.hue).toBeGreaterThanOrEqual(0);
    expect(a.hue).toBeLessThan(360);
    expect(a.breath).toBeGreaterThanOrEqual(5);
    expect(a.breath).toBeLessThanOrEqual(9);
    expect(Math.abs(a.tilt)).toBeLessThanOrEqual(3);
    const names = ["price-watch", "research", "saturdays", "travel", "docs-watch", "shopper"];
    const hues = new Set(names.map((n) => lookOf(n).hue));
    expect(hues.size).toBe(names.length);
    expect(lookOf("")).toEqual(lookOf("kos"));
  });

  it("reads a thread's state as a mood, with a paused schedule asleep", () => {
    expect(moodOf(undefined)).toBe("idle");
    expect(moodOf("idle")).toBe("idle");
    expect(moodOf("working")).toBe("working");
    expect(moodOf("needs-you")).toBe("needs-you");
    expect(moodOf("error")).toBe("error");
    expect(moodOf("working", { paused: true })).toBe("asleep");
  });

  it("renders as an image of the agent, marked by its mood", () => {
    render(<Face seed="research" size={32} mood="needs-you" />);
    const img = screen.getByRole("img", { name: "research, needs you" });
    expect(img.className).toContain("blob--needs-you");
    expect(img.className).toMatch(/blob--w[0-3]/);
    expect(img.getAttribute("style")).toContain("--blob-size: 32px");
    expect(img.textContent).toContain("!");
    cleanup();
    render(<Face seed="research" mood="asleep" label="Research, paused" />);
    const asleep = screen.getByRole("img", { name: "Research, paused" });
    expect(asleep.textContent).toContain("z");
    expect(asleep.textContent).not.toContain("!");
  });
});
