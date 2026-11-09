import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { GAITS } from "./blobmotion.js";
import { COLOURS, FLOAT_SHADOW, isThemeMode, LIGHT_COLOURS, RADII, resolveThemeMode, SPRING, TYPE, type ColourToken } from "./design.js";
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

/** The light palette's block: `:root[data-theme="light"]`. */
function lightRoot(css: string): string {
  return /(^|\n):root\[data-theme="light"\] \{[^}]*\}/.exec(css)?.[0] ?? "";
}

/** A custom property as declared in a block, or nothing. */
function declared(block: string, name: string): string | undefined {
  return new RegExp(`--${name}:\\s*([^;]+);`).exec(block)?.[1]?.trim();
}

const STYLESHEETS = {
  dashboard: read("../../ui/src/styles.css"),
  extension: read("../../browser-extension/static/kos.css"),
};
const KIT = read("../../kit/src/kit.css");
const OVERLAY = read("../../browser-extension/src/overlay.ts");
const SWIFT = read("../../device-macos/Sources/DeviceUI/Theme.swift");
const PALETTE = read("../../device-macos/Sources/KOSDevice/Overlay/Palette.swift");
const FACE = read("../../device-macos/Sources/DeviceUI/FaceLook.swift");

/** The Swift spelling of a token: panel-2 is panel2, line-strong is lineStrong. */
const swiftName = (token: string): string => token.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());

/** A Swift enum's body by its name, wherever it sits in the file. */
function swiftEnum(source: string, name: string): string {
  return new RegExp(`\\benum ${name} \\{([^}]*)\\}`).exec(source)?.[1] ?? "";
}

/** A colour as `#rrggbb`, from a hex or an rgb()/rgba() whose alpha is set aside. */
function rgbOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("#")) return value.toLowerCase();
  const parts = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value);
  return parts ? `#${parts.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, "0")).join("")}` : undefined;
}

/** The bar's own properties, each the token it is drawn in: alpha aside, so a translucent bar is still its panel. */
const BAR_TOKENS = { accent: "accent", violet: "violet", warn: "warn", danger: "danger", bar: "panel", ink: "text", sub: "muted", btn: "panel-2", "btn-line": "line", "btn-line-lit": "line-strong", "btn-lit": "line" } as const;

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

    it(`are the ${surface}'s type scale, which the kit's pieces are set in`, () => {
      const all = roots(css).join("\n");
      for (const [step, rem] of Object.entries(TYPE)) {
        expect(new RegExp(`--text-${step}:\\s*(\\d+(?:\\.\\d+)?)rem`).exec(all)?.[1], `${surface} --text-${step}`).toBe(String(rem));
      }
    });
  }

  for (const [surface, css] of Object.entries(STYLESHEETS)) {
    it(`are the ${surface}'s light colours`, () => {
      const block = lightRoot(css);
      expect(block, `${surface} has a light palette`).toContain("color-scheme: light");
      for (const [token, hex] of Object.entries(LIGHT_COLOURS)) expect(declared(block, token)?.toLowerCase(), `${surface} light --${token}`).toBe(hex);
    });
  }

  it("say which palette a mode lands on", () => {
    expect(resolveThemeMode("system", true)).toBe("light");
    expect(resolveThemeMode("system", false)).toBe("dark");
    expect(resolveThemeMode("light", false)).toBe("light");
    expect(resolveThemeMode("dark", true)).toBe("dark");
    expect(["light", "dark", "system", "dashboard", 1, undefined].map(isThemeMode)).toEqual([true, true, true, false, false, false]);
  });

  it("cover every token the kit's stylesheet uses, in both apps", () => {
    // A var() with a fallback, or one the kit sets itself (a tone a rule passes down), needs no app to declare it.
    const own = new Set([...KIT.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    const used = new Set([...KIT.matchAll(/var\((--[\w-]+)\s*\)/g)].map((m) => m[1]!).filter((name) => !own.has(name)));
    for (const [surface, css] of Object.entries(STYLESHEETS)) {
      for (const name of used) expect(css, `${surface} declares ${name}, which kit.css uses`).toMatch(new RegExp(`${name}\\s*:`));
    }
  });

  it("are the colours of the bar the extension draws into a page", () => {
    const host = /:host \{([^}]*)\}/.exec(OVERLAY)?.[1] ?? "";
    for (const [name, token] of Object.entries(BAR_TOKENS)) expect(rgbOf(declared(host, name)), `overlay --${name}`).toBe(COLOURS[token]);
  });

  it("are the light colours of the bar the extension draws into a page", () => {
    const light = /const light = `([^`]*)`/.exec(OVERLAY)?.[1] ?? "";
    for (const [name, token] of Object.entries(BAR_TOKENS)) expect(rgbOf(declared(light, name)), `overlay light --${name}`).toBe(LIGHT_COLOURS[token]);
    expect(OVERLAY).toContain(':host([data-theme="light"]) { ${light} }');
    expect(OVERLAY).toContain('@media (prefers-color-scheme: light) { :host([data-theme="system"]) { ${light} } }');
  });

  it("are KOS for Mac's colours in both palettes, corners and spring, and its overlay's", () => {
    for (const [palette, colours] of [["Dark", COLOURS], ["Light", LIGHT_COLOURS]] as const) {
      const body = swiftEnum(SWIFT, palette);
      for (const [token, hex] of Object.entries(colours) as [ColourToken, string][]) {
        const found = new RegExp(`static let ${swiftName(token)} = Color\\(hex: 0x([0-9A-Fa-f]{6})\\)`).exec(body)?.[1];
        expect(found && `#${found.toLowerCase()}`, `Theme.${palette}.${swiftName(token)}`).toBe(hex);
      }
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

  it("are KOS for Mac's default face and gaits: what it draws for a KOS that has sent no face", () => {
    const kos = drawingOf(lookOf(KOS_SEED));
    const hex = (c: string): string => `0x${c.slice(1).toUpperCase()}`;
    expect(FACE).toContain(`fill: ${hex(kos.fill)}, ink: ${hex(kos.ink)}, eyes: .${kos.eyes}, gait: ${kos.gait}`);
    expect(FACE).toContain(`Shape(aspect: ${kos.shape.aspect}, squat: ${kos.shape.squat}, spread: ${kos.shape.spread.toFixed(4)}, lobes: [])`);
    for (const g of GAITS) expect(FACE).toContain(`Gait(breath: ${g.breath}, spring: ${g.spring}, settle: ${g.settle}, fidget: ${g.fidget})`);
  });
});
