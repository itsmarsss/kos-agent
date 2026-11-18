/**
 * Keys as a person reads them on a keycap: "Meta+Minus" is ⌘− on a Mac and
 * Ctrl+− elsewhere, "Return" is ⏎. A step that presses keys shows these,
 * never the names a driver takes (Playwright's "Meta+Minus", xdotool's
 * "ctrl+Page_Down").
 */

/** Whose keyboard the keys are said for: a Mac's glyphs, or the words everyone else's caps carry. */
export type KeyPlatform = "mac" | "other";

interface Modifier {
  mac: string;
  other: string;
  /** Where it stands in a chord: Apple's order, ⌃⌥⇧⌘, which Ctrl, Alt, Shift follow too. */
  order: number;
}

const CONTROL: Modifier = { mac: "⌃", other: "Ctrl", order: 0 };
const ALT: Modifier = { mac: "⌥", other: "Alt", order: 1 };
const SHIFT: Modifier = { mac: "⇧", other: "Shift", order: 2 };
/** Meta is Command on a Mac; elsewhere the shortcut a Mac takes with it is taken with Ctrl. */
const META: Modifier = { mac: "⌘", other: "Ctrl", order: 3 };

const MODIFIERS: Record<string, Modifier> = {
  ctrl: CONTROL,
  control: CONTROL,
  alt: ALT,
  option: ALT,
  opt: ALT,
  shift: SHIFT,
  meta: META,
  cmd: META,
  command: META,
  super: META,
  controlormeta: META,
};

/** Named keys, by their name lowercased with no separators: one glyph or word for both, or one each. */
const NAMED: Record<string, string | { mac: string; other: string }> = {
  minus: "−",
  equal: "=",
  plus: "+",
  enter: "⏎",
  return: "⏎",
  kpenter: "⏎",
  tab: "Tab",
  escape: "Esc",
  esc: "Esc",
  backspace: { mac: "⌫", other: "Backspace" },
  delete: { mac: "⌦", other: "Delete" },
  space: "Space",
  arrowup: "↑",
  up: "↑",
  arrowdown: "↓",
  down: "↓",
  arrowleft: "←",
  left: "←",
  arrowright: "→",
  right: "→",
  home: "Home",
  end: "End",
  pageup: "Page Up",
  prior: "Page Up",
  pagedown: "Page Down",
  next: "Page Down",
  capslock: "Caps Lock",
  insert: "Insert",
  comma: ",",
  period: ".",
  slash: "/",
  backslash: "\\",
  semicolon: ";",
  quote: "'",
  backquote: "`",
  bracketleft: "[",
  bracketright: "]",
};

/** One key's cap: a named key's glyph, a letter in capitals, a function key as written. */
function capOf(name: string, platform: KeyPlatform): string {
  const bare = name.toLowerCase().replace(/[\s_-]/g, "");
  const named = NAMED[bare];
  if (named !== undefined) return typeof named === "string" ? named : named[platform];
  // Playwright's code names: KeyA is A, Digit7 is 7.
  const code = /^(?:key|digit)([a-z0-9])$/.exec(bare);
  if (code) return code[1]!.toUpperCase();
  if (/^f\d{1,2}$/.test(bare)) return bare.toUpperCase();
  if (name.length === 1) return name.toUpperCase();
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * One chord ("Meta+Shift+t") as its keycap: on a Mac the glyphs run
 * together, ⌘⇧T; elsewhere they are joined with plus, Ctrl+Shift+T.
 */
export function keyCap(chord: string, platform: KeyPlatform): string {
  // A trailing plus is the key itself: "Meta++" presses Meta and plus.
  const names = chord === "+" ? ["+"] : chord.replace(/\+\+$/, "+plus").split("+").filter((n) => n !== "");
  const held = new Map<number, string>();
  const keys: string[] = [];
  for (const [i, name] of names.entries()) {
    const modifier = MODIFIERS[name.toLowerCase()];
    // A modifier pressed on its own is the key itself ("Shift").
    if (modifier && i < names.length - 1) held.set(modifier.order, modifier[platform]);
    else keys.push(modifier ? modifier[platform] : capOf(name, platform));
  }
  const mods = [...new Set([...held.entries()].sort(([a], [b]) => a - b).map(([, cap]) => cap))];
  return platform === "mac" ? [...mods, ...keys].join("") : [...mods, ...keys].join("+");
}

/**
 * Each chord a press names, as keycaps: one for "Meta+Minus", several for a
 * run a computer types out ("ctrl+a Delete"). Nothing for an empty press.
 */
export function keyCaps(text: string, platform: KeyPlatform): string[] {
  return text
    .trim()
    .split(/\s+/)
    .filter((chord) => chord !== "")
    .map((chord) => keyCap(chord, platform));
}

/**
 * The keyboard a step's keys are pressed on: a computer's is a Mac's, since
 * KOS for Mac is the only computer KOS works; a browser's is where it runs,
 * which the caller knows.
 */
export function keyPlatformOf(tool: string, where: KeyPlatform): KeyPlatform {
  return tool.startsWith("computer.") ? "mac" : where;
}
