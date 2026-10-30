/**
 * A page as the model reads it.
 *
 * Chrome's own accessibility tree is the source: the role and name a screen
 * reader would announce, computed by the browser rather than guessed from
 * the markup. Each line that stands for an element carries a ref, and a ref
 * stays the same for the same element while its document lives, so a plan
 * made from one look still points at the right things three steps later.
 */

export interface AxValue {
  value?: unknown;
}

export interface AxProperty {
  name: string;
  value: AxValue;
}

/** A node of `Accessibility.getFullAXTree`, as much of it as is read here. */
export interface AxNode {
  nodeId: string;
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  properties?: AxProperty[];
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
}

/** Refs for one document: an element keeps its ref, a new one gets the next. */
export class Refs {
  private readonly byNode = new Map<number, string>();
  private readonly byRef = new Map<string, number>();
  private next = 1;

  refOf(node: number): string {
    const known = this.byNode.get(node);
    if (known) return known;
    const ref = `e${this.next++}`;
    this.byNode.set(node, ref);
    this.byRef.set(ref, node);
    return ref;
  }

  nodeOf(ref: string): number | undefined {
    return this.byRef.get(ref);
  }

  /** A new document: its elements are new, and so are their refs. */
  clear(): void {
    this.byNode.clear();
    this.byRef.clear();
    this.next = 1;
  }
}

/** How many controls the index names before it says how many more there are. */
export const INDEX_MAX = 60;
/** How long the whole tree may run before it is cut. */
export const TREE_MAX = 24_000;

/** Roles a reader can act on. */
const CONTROLS = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "option",
  "treeitem",
]);

/** Roles that say nothing of their own: unnamed, their children stand in their place. */
const HOLLOW = new Set(["generic", "none", "presentation", "group", "LayoutTable", "LayoutTableRow", "LayoutTableCell", "Section", "paragraph"]);

/** Never shown: the page itself, and the pieces Chrome splits text into. */
const UNSEEN = new Set(["RootWebArea", "InlineTextBox", "LineBreak"]);

/** Roles whose controls are what the page is waiting on, so they come first. */
const MODAL = new Set(["dialog", "alertdialog"]);

/** Roles that hold a value worth saying. */
const VALUED = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider"]);

function text(v: AxValue | undefined, max: number): string {
  const raw = v?.value;
  if (typeof raw !== "string" && typeof raw !== "number") return "";
  const s = String(raw).replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function quoted(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function prop(node: AxNode, name: string): unknown {
  return node.properties?.find((p) => p.name === name)?.value.value;
}

/** What a control is like right now, in brackets: checked, expanded, disabled. */
function states(node: AxNode): string {
  const out: string[] = [];
  const checked = prop(node, "checked");
  if (checked === "true" || checked === true) out.push("checked");
  else if (checked === "mixed") out.push("mixed");
  else if (checked === "false" || checked === false) out.push("unchecked");
  const pressed = prop(node, "pressed");
  if (pressed === "true" || pressed === true) out.push("pressed");
  const expanded = prop(node, "expanded");
  if (expanded === true) out.push("expanded");
  else if (expanded === false) out.push("collapsed");
  if (prop(node, "selected") === true) out.push("selected");
  if (prop(node, "disabled") === true) out.push("disabled");
  if (prop(node, "focused") === true) out.push("focused");
  const level = prop(node, "level");
  if (typeof level === "number") out.push(`level ${level}`);
  return out.length ? ` [${out.join(", ")}]` : "";
}

/** A node as one line: role, name, state, value, and its ref when it is an element. */
function lineOf(node: AxNode, role: string, refs: Refs): string {
  const name = text(node.name, 100);
  const value = VALUED.has(role) ? text(node.value, 60) : "";
  const ref = node.backendDOMNodeId !== undefined ? ` @${refs.refOf(node.backendDOMNodeId)}` : "";
  return `${role}${name ? ` ${quoted(name)}` : ""}${states(node)}${value ? ` = ${quoted(value)}` : ""}${ref}`;
}

interface Walked {
  node: AxNode;
  role: string;
  depth: number;
  /** The dialog it sits in, by name, when it sits in one. */
  dialog?: string;
}

/** Every node in reading order, with how deep it is among the nodes shown and the dialog it is in. */
function walk(nodes: AxNode[]): Walked[] {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const roots = nodes.filter((n) => !n.parentId || !byId.has(n.parentId));
  const out: Walked[] = [];
  const seen = new Set<string>();
  const visit = (node: AxNode, depth: number, dialog: string | undefined): void => {
    if (seen.has(node.nodeId)) return;
    seen.add(node.nodeId);
    const role = text(node.role, 40);
    const shown = !node.ignored && role !== "" && !UNSEEN.has(role) && !(HOLLOW.has(role) && !text(node.name, 1));
    const inside = !node.ignored && MODAL.has(role) ? text(node.name, 60) || role : dialog;
    if (shown) out.push({ node, role, depth, ...(inside !== undefined ? { dialog: inside } : {}) });
    for (const id of node.childIds ?? []) {
      const child = byId.get(id);
      if (child) visit(child, shown ? depth + 1 : depth, inside);
    }
  };
  for (const root of roots) visit(root, 0, undefined);
  return out;
}

export interface PageIndex {
  /** One line per control, a dialog's first. */
  lines: string[];
  /** How many there were before the cap. */
  total: number;
}

/**
 * What can be acted on, one line each: role, label, state and ref. A dialog's
 * controls come first, under its name, since a page with a dialog open is
 * waiting on it (a cookie banner is the usual one). Links with the same label
 * fold into one line that says how many more there are; buttons do not, as
 * the second "Add to cart" is a different thing to add.
 */
export function indexOf(nodes: AxNode[], refs: Refs, max = INDEX_MAX): PageIndex {
  const groups = new Map<string, string[]>();
  const links = new Map<string, { at: string[]; i: number; more: number }>();
  let total = 0;
  for (const { node, role, dialog } of walk(nodes)) {
    if (!CONTROLS.has(role) || node.backendDOMNodeId === undefined) continue;
    const name = text(node.name, 100);
    if (!name && role === "link") continue;
    const key = dialog ?? "";
    const lines = groups.get(key) ?? [];
    groups.set(key, lines);
    if (role === "link") {
      const same = links.get(`${key}|${name}`);
      if (same) {
        same.more++;
        continue;
      }
      links.set(`${key}|${name}`, { at: lines, i: lines.length, more: 0 });
    }
    lines.push(lineOf(node, role, refs));
    total++;
  }
  for (const { at, i, more } of links.values()) if (more) at[i] = `${at[i]} (+${more} more like it)`;
  const ordered: string[] = [];
  for (const [dialog, lines] of groups) {
    if (!dialog) continue;
    ordered.push(`In the dialog ${quoted(dialog)}:`, ...lines.map((l) => `  ${l}`));
  }
  const page = groups.get("") ?? [];
  if (ordered.length && page.length) ordered.push("On the page:");
  ordered.push(...page);
  return { lines: cap(ordered, max), total };
}

/** The first `max` controls, the dialog headings around them kept. */
function cap(lines: string[], max: number): string[] {
  const out: string[] = [];
  let controls = 0;
  for (const line of lines) {
    const heading = line.endsWith(":") && !line.includes("@");
    if (!heading && controls >= max) break;
    out.push(line);
    if (!heading) controls++;
  }
  // A heading with nothing under it says nothing.
  while (out.length && out[out.length - 1]!.endsWith(":") && !out[out.length - 1]!.includes("@")) out.pop();
  return out;
}

/**
 * The whole page as an indented outline: headings, text, landmarks and
 * controls, each element with its ref. Text a control already says as its
 * name is not said again under it. Cut at `maxChars`.
 */
export function treeOf(nodes: AxNode[], refs: Refs, maxChars = TREE_MAX): { text: string; cut: boolean } {
  const out: string[] = [];
  let size = 0;
  const said: string[] = [];
  for (const { node, role, depth } of walk(nodes)) {
    said.length = depth;
    let line: string;
    if (role === "StaticText") {
      const words = text(node.name, 400);
      if (!words || said.some((s) => s === words)) continue;
      line = `text ${quoted(words)}`;
    } else {
      line = lineOf(node, role, refs);
    }
    said[depth] = text(node.name, 400);
    const entry = `${"  ".repeat(depth)}- ${line}`;
    if (size + entry.length + 1 > maxChars) return { text: out.join("\n"), cut: true };
    out.push(entry);
    size += entry.length + 1;
  }
  return { text: out.join("\n"), cut: false };
}
