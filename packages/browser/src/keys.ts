/**
 * A key press as Chrome wants it.
 *
 * The model names keys the way people write them, "Enter" or "Meta+a";
 * Chrome wants a key, a code, a Windows key code, the text the key types
 * and a bitmask of modifiers. And on a Mac, Meta+A selects nothing when
 * sent as a key: the editing shortcuts are commands, so they are sent as
 * those too.
 */

export interface KeyPress {
  key: string;
  code: string;
  keyCode: number;
  /** What the key types, when it types something and no shortcut modifier is held. */
  text?: string;
  /** Alt 1, Control 2, Meta 4, Shift 8. */
  modifiers: number;
  /** The modifier keys held, in the order they go down. */
  held: { key: string; code: string; keyCode: number; bit: number }[];
  /** Editor commands the shortcut stands for. */
  commands?: string[];
}

const MODIFIERS: Record<string, { key: string; code: string; keyCode: number; bit: number }> = {
  alt: { key: "Alt", code: "AltLeft", keyCode: 18, bit: 1 },
  option: { key: "Alt", code: "AltLeft", keyCode: 18, bit: 1 },
  control: { key: "Control", code: "ControlLeft", keyCode: 17, bit: 2 },
  ctrl: { key: "Control", code: "ControlLeft", keyCode: 17, bit: 2 },
  meta: { key: "Meta", code: "MetaLeft", keyCode: 91, bit: 4 },
  cmd: { key: "Meta", code: "MetaLeft", keyCode: 91, bit: 4 },
  command: { key: "Meta", code: "MetaLeft", keyCode: 91, bit: 4 },
  shift: { key: "Shift", code: "ShiftLeft", keyCode: 16, bit: 8 },
};

const NAMED: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  insert: { key: "Insert", code: "Insert", keyCode: 45 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};

/** Punctuation on a US keyboard: its code and key code. */
const PUNCTUATION: Record<string, { code: string; keyCode: number }> = {
  "-": { code: "Minus", keyCode: 189 },
  "=": { code: "Equal", keyCode: 187 },
  "[": { code: "BracketLeft", keyCode: 219 },
  "]": { code: "BracketRight", keyCode: 221 },
  "\\": { code: "Backslash", keyCode: 220 },
  ";": { code: "Semicolon", keyCode: 186 },
  "'": { code: "Quote", keyCode: 222 },
  ",": { code: "Comma", keyCode: 188 },
  ".": { code: "Period", keyCode: 190 },
  "/": { code: "Slash", keyCode: 191 },
  "`": { code: "Backquote", keyCode: 192 },
};

/** Shortcuts that are editor commands, by the letter held with Control or Meta. */
const COMMANDS: Record<string, string> = { a: "selectAll", c: "copy", x: "cut", v: "paste", z: "undo", y: "redo" };

function keyOf(name: string): { key: string; code: string; keyCode: number; text?: string } {
  const named = NAMED[name.toLowerCase()];
  if (named) return named;
  const fn = /^f([1-9]|1[0-2])$/i.exec(name);
  if (fn) return { key: `F${fn[1]}`, code: `F${fn[1]}`, keyCode: 111 + Number(fn[1]) };
  if ([...name].length !== 1) throw new Error(`unknown key "${name}"; name one like Enter, Tab, Escape, ArrowDown, a, or a combination like Meta+a`);
  if (/^[a-z]$/i.test(name)) return { key: name, code: `Key${name.toUpperCase()}`, keyCode: name.toUpperCase().charCodeAt(0), text: name };
  if (/^[0-9]$/.test(name)) return { key: name, code: `Digit${name}`, keyCode: 48 + Number(name), text: name };
  const punct = PUNCTUATION[name];
  return { key: name, code: punct?.code ?? "", keyCode: punct?.keyCode ?? 0, text: name };
}

/** "Shift+Tab", "Meta+a", "Enter": a press, its modifiers held around it. */
export function parseKeys(combo: string): KeyPress {
  const raw = combo.trim();
  if (!raw) throw new Error("a key is needed, like Enter or Meta+a");
  // "+" alone, or ending a combination ("Shift++"), is the plus key.
  const parts = raw === "+" ? ["+"] : raw.endsWith("++") ? [...raw.slice(0, -2).split("+"), "+"] : raw.split("+");
  const last = parts.pop()!.trim();
  const held = parts.map((p) => {
    const m = MODIFIERS[p.trim().toLowerCase()];
    if (!m) throw new Error(`unknown modifier "${p.trim()}"; use Shift, Control, Alt or Meta`);
    return m;
  });
  const base = keyOf(last);
  const modifiers = held.reduce((bits, m) => bits | m.bit, 0);
  const shortcut = (modifiers & (2 | 4)) !== 0;
  const shifted = (modifiers & 8) !== 0;
  const press: KeyPress = { key: base.key, code: base.code, keyCode: base.keyCode, modifiers, held };
  if (/^[a-z]$/i.test(base.key)) {
    press.key = shifted ? base.key.toUpperCase() : base.key.toLowerCase();
    const command = shortcut ? COMMANDS[base.key.toLowerCase()] : undefined;
    if (command) press.commands = [command === "undo" && shifted ? "redo" : command];
  }
  if (base.text !== undefined && !shortcut) press.text = /^[a-z]$/i.test(base.key) ? press.key : base.text;
  return press;
}
