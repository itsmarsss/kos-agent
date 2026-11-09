/**
 * KOS's design tokens: the one place the dashboard, the extension and KOS
 * Device take their colours, corners and motion from. The CSS and the Swift
 * declare the same values by name, and design.test.ts holds them to it, so
 * the three cannot drift apart again. docs/design.md says what each is for.
 * Imported as @kos/shared/design too, apart from the rest of @kos/shared,
 * by what must stay small: the extension's theme script in each page's head.
 */

/** The palette, by token name as the CSS spells it. */
export const COLOURS = {
  bg: "#0c0e12",
  panel: "#12151c",
  "panel-2": "#181c26",
  line: "#262b36",
  "line-strong": "#3a4150",
  text: "#e7ebf3",
  muted: "#8b93a7",
  faint: "#5c6578",
  accent: "#7c9cff",
  "accent-lit": "#9bb4ff",
  "on-accent": "#0b0e14",
  violet: "#a57cff",
  ok: "#3ecf8e",
  warn: "#e6b84d",
  danger: "#f07178",
} as const;

export type ColourToken = keyof typeof COLOURS;

/**
 * The light palette: the same roles, chosen for paper rather than flipped
 * from the dark set. The accent and the state colours go darker so they
 * clear 4.5:1 on white, and text on them turns white in step.
 */
export const LIGHT_COLOURS: Record<ColourToken, string> = {
  bg: "#f4f5f8",
  panel: "#ffffff",
  "panel-2": "#eceef3",
  line: "#dde1e8",
  "line-strong": "#bfc6d3",
  text: "#161a22",
  muted: "#58607a",
  faint: "#8089a0",
  accent: "#3558d6",
  "accent-lit": "#2a47b8",
  "on-accent": "#ffffff",
  violet: "#7b4fd6",
  ok: "#0f6e45",
  warn: "#7d5400",
  danger: "#cf3b47",
};

/**
 * How KOS is drawn: one palette, or whichever the system asks for. The
 * dashboard's choice is KOS's own setting, told to every device, which may
 * follow it or keep its own.
 */
export type ThemeMode = "light" | "dark" | "system";

export function isThemeMode(v: unknown): v is ThemeMode {
  return v === "light" || v === "dark" || v === "system";
}

/** A palette as drawn: what a mode lands on once "system" is read. */
export type DrawnTheme = "light" | "dark";

export function isDrawnTheme(v: unknown): v is DrawnTheme {
  return v === "light" || v === "dark";
}

/**
 * The dashboard's theme as KOS tells a device: the owner's setting, and the
 * palette a dashboard last reported drawing it in. A device that follows the
 * dashboard draws `drawn` when there is one, else `mode`.
 */
export interface DashboardTheme {
  mode: ThemeMode;
  drawn?: DrawnTheme;
}

/** A dashboard theme as stored or sent, or nothing when it is not one: a bare mode (as older versions kept it) is one without a palette. */
export function readDashboardTheme(v: unknown): DashboardTheme | undefined {
  if (isThemeMode(v)) return { mode: v };
  if (typeof v !== "object" || v === null) return undefined;
  const { mode, drawn } = v as Record<string, unknown>;
  return isThemeMode(mode) ? { mode, ...(isDrawnTheme(drawn) ? { drawn } : {}) } : undefined;
}

/** The palette a mode lands on, given whether the system prefers light. */
export function resolveThemeMode(mode: ThemeMode, prefersLight: boolean): DrawnTheme {
  return mode === "system" ? (prefersLight ? "light" : "dark") : mode;
}

/** Corner radii, in px. */
export const RADII = { xs: 4, sm: 7, md: 10, lg: 14 } as const;

/** The type scale in rem, by step as the CSS spells it (--text-md): what @kos/kit's pieces are set in on both web surfaces. */
export const TYPE = { xs: 0.6875, sm: 0.75, base: 0.8125, md: 0.875, lg: 0.9375, xl: 1.125, "2xl": 1.375 } as const;

/** The one spring anything that moves into place uses. */
export const SPRING = { stiffness: 420, damping: 38, mass: 0.9 } as const;

/** Fades and small slides. */
export const EASE = { duration: 0.18, curve: [0.32, 0.72, 0, 1] } as const;

/** What floats over the page casts this, and nothing else casts a shadow. */
export const FLOAT_SHADOW = "0 12px 32px rgba(0, 0, 0, 0.45)";
