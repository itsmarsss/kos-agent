// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AgentFaces, Face, faceSvg, lookOf, moodOf } from "./Face.js";

afterEach(cleanup);

describe("an agent's face", () => {
  it("is the same for the same name, within range, and differs between names", () => {
    const a = lookOf("price-watch");
    expect(lookOf("Price-Watch ")).toEqual(a);
    expect(a.hue).toBeGreaterThanOrEqual(0);
    expect(a.hue).toBeLessThan(360);
    expect(a.breath).toBeGreaterThanOrEqual(3);
    expect(a.breath).toBeLessThanOrEqual(8);
    expect(Math.abs(a.tilt)).toBeLessThanOrEqual(3);
    const names = ["price-watch", "research", "saturdays", "travel", "docs-watch", "shopper"];
    const hues = new Set(names.map((n) => lookOf(n).hue));
    expect(hues.size).toBe(names.length);
    expect(lookOf("")).toEqual(lookOf("kos"));
  });

  it("takes what the owner set over the name, and only what is in range", () => {
    const base = lookOf("research");
    const set = lookOf("research", { hue: 400, eyes: "half", gait: 3 });
    expect(set).toMatchObject({ hue: 40, eyes: "half", wobble: 3 });
    expect(lookOf("research", { hue: Number.NaN, gait: 7 as never })).toEqual(base);
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
    expect(img.getAttribute("style")).toContain("--blob-size: 32px");
    expect(img.querySelector("svg")?.getAttribute("width")).toBe("32");
    expect(img.querySelector('[data-part="body"]')?.getAttribute("d")).toMatch(/^M.* Z$/);
    expect(img.textContent).toContain("!");
    cleanup();
    render(<Face seed="research" mood="asleep" label="Research, paused" />);
    const asleep = screen.getByRole("img", { name: "Research, paused" });
    expect(asleep.textContent).toContain("z");
    expect(asleep.textContent).not.toContain("!");
  });

  it("wears what the file says wherever it is drawn from the name alone", () => {
    render(
      <AgentFaces.Provider value={new Map([["research", { hue: 123 }]])}>
        <Face seed="research" />
      </AgentFaces.Provider>,
    );
    expect(screen.getByRole("img").getAttribute("style")).toContain("--blob-h: 123");
  });

  it("draws the same look still, for the tab icon", () => {
    const look = lookOf("kos", { hue: 200, eyes: "sparkle", gait: 1 });
    const idle = faceSvg(look);
    expect(idle).toContain("hsl(200 88% 80%)");
    expect(idle).toContain('fill="#fff"'); // the sparkle
    expect(idle).not.toContain(">!<");
    const needs = faceSvg(look, "needs-you");
    expect(needs).toContain(">!<");
    expect(faceSvg(look, "asleep")).toContain(">z<");
    expect(faceSvg(look, "error")).toContain("hsl(200 40% 80%)");
  });
});
