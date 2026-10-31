/**
 * KOS's design tokens: the one place the dashboard, the extension and KOS
 * Device take their colours, corners and motion from. The CSS and the Swift
 * declare the same values by name, and design.test.ts holds them to it, so
 * the three cannot drift apart again. docs/design.md says what each is for.
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

/** Tint strengths, in percent: a token mixed into transparent at this share. */
export const TINTS = { quiet: 8, dim: 14, strong: 18, soft: 25, edge: 45 } as const;

/** Corner radii, in px. */
export const RADII = { xs: 4, sm: 7, md: 10, lg: 14 } as const;

/** The one spring anything that moves into place uses. */
export const SPRING = { stiffness: 420, damping: 38, mass: 0.9 } as const;

/** Fades and small slides. */
export const EASE = { duration: 0.18, curve: [0.32, 0.72, 0, 1] } as const;

/** Hover and press, in ms, and the pressed scale. */
export const RESPONSE = { hover: 140, press: 80, pressed: 0.97 } as const;

/** What floats over the page casts this, and nothing else casts a shadow. */
export const FLOAT_SHADOW = "0 12px 32px rgba(0, 0, 0, 0.45)";
