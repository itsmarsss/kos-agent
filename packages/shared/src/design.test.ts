import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { COLOURS, RADII, SPRING, type ColourToken } from "./design.js";

/**
 * The three surfaces declare the tokens themselves, in CSS and in Swift; this
 * is what keeps them the tokens in design.ts rather than three palettes that
 * happen to agree today.
 */

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

/** The first :root block: the dark palette both stylesheets lead with. */
function rootOf(css: string): string {
  const at = css.indexOf(":root {");
  return css.slice(at, css.indexOf("}", at));
}

/** Every :root block, where the dashboard also keeps its radii. */
function roots(css: string): string {
  return [...css.matchAll(/:root \{[^}]*\}/g)].map((m) => m[0]).join("\n");
}

const STYLESHEETS = {
  dashboard: read("../../ui/src/styles.css"),
  extension: read("../../browser-extension/static/kos.css"),
};
const SWIFT = read("../../device-macos/Sources/DeviceUI/Theme.swift");

/** The Swift spelling of a token: panel-2 is panel2, line-strong is lineStrong. */
const swiftName = (token: string): string => token.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());

describe("the design tokens", () => {
  for (const [surface, css] of Object.entries(STYLESHEETS)) {
    it(`are the ${surface}'s colours`, () => {
      const root = rootOf(css);
      for (const [token, hex] of Object.entries(COLOURS)) {
        expect(new RegExp(`--${token}:\\s*([^;]+);`).exec(root)?.[1]?.trim().toLowerCase(), `${surface} --${token}`).toBe(hex);
      }
    });

    it(`are the ${surface}'s corners`, () => {
      const all = roots(css);
      for (const [size, px] of Object.entries(RADII)) {
        expect(new RegExp(`--r-${size}:\\s*(\\d+)px`).exec(all)?.[1], `${surface} --r-${size}`).toBe(String(px));
      }
    });
  }

  it("are KOS Device's colours, corners and spring", () => {
    for (const [token, hex] of Object.entries(COLOURS) as [ColourToken, string][]) {
      const declared = new RegExp(`static let ${swiftName(token)} = Color\\(hex: 0x([0-9A-Fa-f]{6})\\)`).exec(SWIFT)?.[1];
      expect(declared && `#${declared.toLowerCase()}`, `Theme.${swiftName(token)}`).toBe(hex);
    }
    for (const [size, px] of Object.entries(RADII)) {
      const name = `radius${size[0]!.toUpperCase()}${size.slice(1)}`;
      expect(new RegExp(`static let ${name}: CGFloat = (\\d+)`).exec(SWIFT)?.[1], `Theme.${name}`).toBe(String(px));
    }
    expect(SWIFT).toContain(`interpolatingSpring(mass: ${SPRING.mass}, stiffness: ${SPRING.stiffness}, damping: ${SPRING.damping})`);
  });
});
