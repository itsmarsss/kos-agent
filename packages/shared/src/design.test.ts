import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { GAITS } from "./blobmotion.js";
import { COLOURS, FLOAT_SHADOW, RADII, SPRING, type ColourToken } from "./design.js";
import { KOS_SEED, drawingOf, lookOf } from "./face.js";

/**
 * The three surfaces declare the tokens themselves, in CSS and in Swift; this
 * is what keeps them the tokens in design.ts rather than three palettes that
 * happen to agree today.
 */

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

/** Every plain :root block (the dark palette and what follows it), not a theme's override. */
function roots(css: string): string[] {
  return [...css.matchAll(/(^|\n):root \{[^}]*\}/g)].map((m) => m[0]);
}

/** A custom property as declared in a block, or nothing. */
function declared(block: string, name: string): string | undefined {
  return new RegExp(`--${name}:\\s*([^;]+);`).exec(block)?.[1]?.trim();
}

const STYLESHEETS = {
  dashboard: read("../../ui/src/styles.css"),
  extension: read("../../browser-extension/static/kos.css"),
};
const OVERLAY = read("../../browser-extension/src/overlay.ts");
const SWIFT = read("../../device-macos/Sources/DeviceUI/Theme.swift");
const PALETTE = read("../../device-macos/Sources/KOSDevice/Overlay/Palette.swift");
const FACE = read("../../device-macos/Sources/DeviceUI/FaceLook.swift");

/** The Swift spelling of a token: panel-2 is panel2, line-strong is lineStrong. */
const swiftName = (token: string): string => token.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());

describe("the design tokens", () => {
  for (const [surface, css] of Object.entries(STYLESHEETS)) {
    it(`are the ${surface}'s colours, and no later :root changes one`, () => {
      const blocks = roots(css);
      for (const [token, hex] of Object.entries(COLOURS)) {
        expect(declared(blocks[0] ?? "", token)?.toLowerCase(), `${surface} --${token}`).toBe(hex);
        for (const block of blocks.slice(1)) {
          const again = declared(block, token);
          if (again !== undefined) expect(again.toLowerCase(), `${surface} --${token} redeclared`).toBe(hex);
        }
      }
    });

    it(`are the ${surface}'s corners and its floating shadow`, () => {
      const all = roots(css).join("\n");
      for (const [size, px] of Object.entries(RADII)) {
        expect(new RegExp(`--r-${size}:\\s*(\\d+(?:\\.\\d+)?)px`).exec(all)?.[1], `${surface} --r-${size}`).toBe(String(px));
      }
      expect(declared(all, "float"), `${surface} --float`).toBe(FLOAT_SHADOW);
    });
  }

  it("are the colours of the bar the extension draws into a page", () => {
    const host = /:host \{([^}]*)\}/.exec(OVERLAY)?.[1] ?? "";
    for (const token of ["accent", "violet", "warn", "danger"] as const) {
      expect(declared(host, token)?.toLowerCase(), `overlay --${token}`).toBe(COLOURS[token]);
    }
  });

  it("are KOS Device's colours, corners and spring, and its overlay's", () => {
    for (const [token, hex] of Object.entries(COLOURS) as [ColourToken, string][]) {
      const found = new RegExp(`static let ${swiftName(token)} = Color\\(hex: 0x([0-9A-Fa-f]{6})\\)`).exec(SWIFT)?.[1];
      expect(found && `#${found.toLowerCase()}`, `Theme.${swiftName(token)}`).toBe(hex);
    }
    for (const [size, px] of Object.entries(RADII)) {
      const name = `radius${size[0]!.toUpperCase()}${size.slice(1)}`;
      expect(new RegExp(`static let ${name}: CGFloat = (\\d+(?:\\.\\d+)?)\\b`).exec(SWIFT)?.[1], `Theme.${name}`).toBe(String(px));
    }
    expect(SWIFT).toContain(`interpolatingSpring(mass: ${SPRING.mass}, stiffness: ${SPRING.stiffness}, damping: ${SPRING.damping})`);
    for (const [name, token] of [["accent", "accent"], ["violet", "violet"], ["amber", "warn"]] as const) {
      const rgb = new RegExp(`static let ${name} = NSColor\\(srgbRed: 0x(\\w\\w) / 255, green: 0x(\\w\\w) / 255, blue: 0x(\\w\\w) / 255`).exec(PALETTE);
      expect(rgb && `#${rgb.slice(1, 4).join("").toLowerCase()}`, `Palette.${name}`).toBe(COLOURS[token]);
    }
  });

  it("are KOS Device's default face and gaits: what it draws for a KOS that has sent no face", () => {
    const kos = drawingOf(lookOf(KOS_SEED));
    const hex = (c: string): string => `0x${c.slice(1).toUpperCase()}`;
    expect(FACE).toContain(`fill: ${hex(kos.fill)}, ink: ${hex(kos.ink)}, eyes: .${kos.eyes}, gait: ${kos.gait}`);
    expect(FACE).toContain(`Shape(aspect: ${kos.shape.aspect}, squat: ${kos.shape.squat}, spread: ${kos.shape.spread.toFixed(4)}, lobes: [])`);
    for (const g of GAITS) expect(FACE).toContain(`Gait(breath: ${g.breath}, spring: ${g.spring}, settle: ${g.settle}, fidget: ${g.fidget})`);
  });
});
