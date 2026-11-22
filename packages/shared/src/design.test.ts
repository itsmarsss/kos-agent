import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { GAITS } from "./blobmotion.js";
import { COLOURS, FLOAT_SHADOW, HOVER, isDrawnTheme, isThemeMode, LIGHT_COLOURS, PRESS, RADII, readDashboardTheme, resolveThemeMode, SPRING, TYPE, type ColourToken } from "./design.js";
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
const SWIFT = read("../../device-shared/Sources/DeviceKit/Theme.swift");
const PALETTE = read("../../device-macos/Sources/KOSDevice/Overlay/Palette.swift");
const FACE = read("../../device-shared/Sources/DeviceKit/FaceLook.swift");

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

    it(`are the ${surface}'s one hover and one press`, () => {
      const all = roots(css).join("\n");
      expect(declared(all, "hover"), `${surface} --hover`).toBe(HOVER);
      expect(declared(all, "press"), `${surface} --press`).toBe(PRESS.transition);
      expect(declared(all, "press-scale"), `${surface} --press-scale`).toBe(String(PRESS.scale));
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
    expect(["light", "dark", "system", 1, undefined].map(isDrawnTheme)).toEqual([true, true, false, false, false]);
  });

  it("read a dashboard theme as sent or kept, and an older bare mode as one without a palette", () => {
    expect(readDashboardTheme({ mode: "system", drawn: "dark" })).toEqual({ mode: "system", drawn: "dark" });
    expect(readDashboardTheme({ mode: "system", drawn: "system" })).toEqual({ mode: "system" });
    expect(readDashboardTheme("light")).toEqual({ mode: "light" });
    for (const bad of [{ drawn: "dark" }, { mode: "sepia" }, "sepia", null, 1]) expect(readDashboardTheme(bad)).toBeUndefined();
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
    const host = /const dark = important\(`([^`]*)`\)/.exec(OVERLAY)?.[1] ?? "";
    expect(OVERLAY).toContain(":host { ${dark} }");
    for (const [name, token] of Object.entries(BAR_TOKENS)) expect(rgbOf(declared(host, name)), `overlay --${name}`).toBe(COLOURS[token]);
  });

  it("are the light colours of the bar the extension draws into a page", () => {
    const light = /const light = important\(`([^`]*)`\)/.exec(OVERLAY)?.[1] ?? "";
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

/** The web sheets every page of the dashboard is drawn with. */
const WEB_SHEETS = { "styles.css": STYLESHEETS.dashboard, "kit.css": KIT, "page.css": read("../../kit/src/page.css") };

/** Each declaration of a property in a sheet, with its line, comments set aside. */
function declarations(css: string, property: string): { line: number; value: string }[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  return [...bare.matchAll(new RegExp(`(?:^|[;{\\s])${property}:\\s*([^;}]+)`, "g"))].map((m) => ({ line: bare.slice(0, m.index).split("\n").length, value: m[1]!.trim() }));
}

/** A corner is a token, a capsule (999px), a circle or other share of the box, none, or its parent's. */
const cornerOk = (value: string): boolean => value.split(/\s+/).every((v) => /^var\(--r-(xs|sm|md|lg)\)$/.test(v) || /^(0|999px|inherit|\d+(\.\d+)?%)$/.test(v));

/** A list's items split at its commas, not those inside a function's brackets. */
function topLevel(value: string): string[] {
  const parts = [""];
  let depth = 0;
  for (const c of value) {
    depth += c === "(" ? 1 : c === ")" ? -1 : 0;
    if (c === "," && depth === 0) parts.push("");
    else parts[parts.length - 1] += c;
  }
  return parts;
}

/** A shadow that floats is --float; a ring (no offset, no blur) or an inset line is a border drawn another way. */
function shadowOk(value: string): boolean {
  if (value === "none") return true;
  return topLevel(value).every((part) => {
    const p = part.trim();
    if (p === "var(--float)" || p.startsWith("inset ")) return true;
    // x, y and blur all nothing: a ring, its spread the line's width.
    return p.split(/\s+/).slice(0, 3).every((n) => /^0(px)?$/.test(n));
  });
}

describe("the web sheets keep to the tokens", () => {
  for (const [sheet, css] of Object.entries(WEB_SHEETS)) {
    it(`${sheet} rounds corners only by the --r-* steps or a capsule`, () => {
      const off = declarations(css, "border(?:-(?:top|bottom)-(?:left|right))?-radius").filter((d) => !cornerOk(d.value));
      expect(off.map((d) => `line ${d.line}: ${d.value}`)).toEqual([]);
    });

    it(`${sheet} sets type at 400, 500, 600 or 700 only`, () => {
      const off = declarations(css, "font-weight").filter((d) => !/^(400|500|600|700|inherit|normal|var\(--title-weight(, 700)?\))$/.test(d.value));
      expect(off.map((d) => `line ${d.line}: ${d.value}`)).toEqual([]);
    });

    it(`${sheet} casts only the floating shadow`, () => {
      const off = declarations(css, "box-shadow").filter((d) => !shadowOk(d.value));
      expect(off.map((d) => `line ${d.line}: ${d.value}`)).toEqual([]);
    });
  }

  it("draws a button at one of two heights, the control tokens", () => {
    const dashboard = STYLESHEETS.dashboard;
    expect(/\.btn \{[^}]*height: var\(--control-h\);/.exec(dashboard), ".btn").not.toBeNull();
    expect(/\.btn--sm \{[^}]*height: var\(--control-h-sm\);/.exec(dashboard), ".btn--sm").not.toBeNull();
    const heights = [...dashboard.matchAll(/\.btn[\w-]*[^{]*\{[^}]*\bheight:\s*([^;}]+)/g)].map((m) => m[1]!.trim());
    expect(heights.filter((h) => !/^var\(--control-h(-sm)?\)$|^auto$/.test(h))).toEqual([]);
  });

  it("has no second set of corners beside --r-*", () => {
    for (const css of Object.values(STYLESHEETS)) expect(css).not.toMatch(/--radius\s*:/);
  });
});

/** WCAG's contrast ratio between two `#rrggbb` colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string): number => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe("the text tokens", () => {
  // Small text (11 to 14 px) is set in all three, the faint tier too: rail times, labels, the meter's detail.
  for (const [theme, palette] of [["dark", COLOURS], ["light", LIGHT_COLOURS]] as const) {
    for (const token of ["text", "muted", "faint"] as const) {
      it(`reads ${token} at 4.5:1 or more on the ${theme} page and panel`, () => {
        expect(contrast(palette[token], palette.bg)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(palette[token], palette.panel)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});
