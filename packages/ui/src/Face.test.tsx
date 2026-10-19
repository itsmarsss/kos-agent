// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { outline, smoothPath } from "./blob.js";
import { hexOfHsl, hueOfHex } from "./colour.js";
import { AgentFaces, Face, faceLookOf, faceSvg, fillOf, lookOf, moodOf } from "./Face.js";

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
    // A silhouette and habits of its own, each within its range.
    for (const n of names) {
      const { shape, whim } = lookOf(n);
      expect(shape.aspect).toBeGreaterThanOrEqual(0.92);
      expect(shape.aspect).toBeLessThanOrEqual(1.12);
      expect([0, 0.12, 0.24]).toContainEqual(Number(shape.squat.toFixed(2)));
      expect(shape.spread).toBeGreaterThanOrEqual(0.88);
      expect(shape.spread).toBeLessThanOrEqual(1.1);
      expect(whim.curiosity).toBeGreaterThanOrEqual(0.7);
      expect(whim.blinkiness).toBeLessThanOrEqual(1.3);
    }
    expect(new Set(names.map((n) => JSON.stringify(lookOf(n).shape))).size).toBeGreaterThan(3);
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
    expect(idle).toContain(`fill="${fillOf(200)}"`);
    expect(idle).toContain('fill="#fff"'); // the glint
    expect(idle).not.toContain(">!<");
    expect(idle).not.toContain("radialGradient");
    // The same silhouette the live blob has, held still.
    expect(idle).toContain(`d="${smoothPath(outline(look.shape))}"`);
    const needs = faceSvg(look, "needs-you");
    expect(needs).toContain(">!<");
    expect(faceSvg(look, "asleep")).toContain(">z<");
    // Drained on an error, and the eyes are lines.
    expect(faceSvg(look, "error")).toContain(`fill="${fillOf(200, 0.45)}"`);
    expect(faceSvg(look, "error")).toMatch(/rotate\(18 /);
    expect(faceSvg(lookOf("kos", { eyes: "round" }))).toContain("<circle");
    // Two eyes and nothing else.
    expect(idle).not.toContain("<path d=\"M4");
  });

  it("keeps its colour soft around the wheel", () => {
    // Yellow is lifted, blue is eased down, and nothing is mud or neon.
    expect(fillOf(60)).toBe("hsl(60 84% 64%)");
    expect(fillOf(240)).toBe("hsl(240 84% 56%)");
    expect(fillOf(0, 0.5)).toBe("hsl(0 42% 61%)");
    // KOS is not left to the hash: a clear blue with tall eyes, lively.
    expect(lookOf("kos")).toMatchObject({ hue: 214, eyes: "half", wobble: 1, tilt: 0 });
    expect(lookOf("kos", { hue: 300 }).hue).toBe(300);
  });

  it("wears a picked colour as it is, takes its hue for the accents, and goes pale-eyed on a dark one", () => {
    const violet = lookOf("kos", { colour: "#8B5CF6" });
    expect(violet.fill).toBe("#8b5cf6");
    expect(violet.colour).toBe("#8b5cf6");
    expect(violet.hue).toBe(hueOfHex("#8b5cf6"));
    expect(violet.ink).toBe(hexOfHsl(violet.hue, 35, 12));
    const night = lookOf("kos", { colour: "#1b1f3a" });
    expect(night.ink).toBe(hexOfHsl(night.hue, 30, 92));
    // A grey has no hue of its own, so the name's (or the set hue) stays for the accents.
    expect(lookOf("kos", { colour: "#808080" }).hue).toBe(214);
    expect(lookOf("kos", { colour: "#808080", hue: 30 }).hue).toBe(30);
    // Not a hex colour: ignored, and the hue's fill stands.
    expect(lookOf("kos", { colour: "blue" }).fill).toBe(lookOf("kos").fill);
    // The still icon draws the picked colour, desaturated when unwell.
    expect(faceSvg(violet)).toContain('fill="#8b5cf6"');
    expect(faceSvg(violet, "error")).not.toContain('fill="#8b5cf6"');
    expect(faceLookOf(violet)).toMatchObject({ colour: "#8b5cf6", eyes: "half", gait: 1 });
  });
});
