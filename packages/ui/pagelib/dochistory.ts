/**
 * The doc editor's undo and redo: the article's contents and the selection,
 * kept before each change. The editor moves blocks itself, outside the
 * browser's editing commands, so the browser's own undo would skip those
 * moves and then undo the wrong text; one history of whole states covers
 * typing, formats and block operations alike. A run of typing is one step.
 */

/** A place as a path of child indexes from the article, so it survives the contents being put back as a copy. */
interface Spot {
  path: number[];
  offset: number;
}
interface State {
  nodes: Node[];
  anchor?: Spot;
  focus?: Spot;
}

/** How many steps are kept, and the most characters they may hold between them (pictures inline are large). */
export const HISTORY_STEPS = 200;
export const HISTORY_CHARS = 12_000_000;

function spotOf(root: Node, node: Node | null, offset: number): Spot | undefined {
  if (!node || !root.contains(node)) return undefined;
  const path: number[] = [];
  for (let n: Node = node; n !== root; n = n.parentNode!) path.unshift([...n.parentNode!.childNodes].indexOf(n as ChildNode));
  return { path, offset };
}

function nodeAt(root: Node, spot: Spot): { node: Node; offset: number } | undefined {
  let n: Node = root;
  for (const i of spot.path) {
    const next = n.childNodes[i];
    if (!next) return undefined;
    n = next;
  }
  const max = n.nodeType === 3 ? (n as Text).length : n.childNodes.length;
  return { node: n, offset: Math.min(spot.offset, max) };
}

const sizeOf = (s: State): number => s.nodes.reduce((sum, n) => sum + (n instanceof Element ? n.outerHTML.length : (n.textContent?.length ?? 0)), 0);

export class History {
  private past: State[] = [];
  private future: State[] = [];
  private typing: { at: number; kind: string } | undefined;

  constructor(private readonly root: HTMLElement) {}

  private now(): State {
    const sel = this.root.ownerDocument.getSelection();
    const state: State = { nodes: [...this.root.childNodes].map((n) => n.cloneNode(true)) };
    if (sel && sel.rangeCount) {
      const anchor = spotOf(this.root, sel.anchorNode, sel.anchorOffset);
      const focus = spotOf(this.root, sel.focusNode, sel.focusOffset);
      if (anchor) state.anchor = anchor;
      if (focus) state.focus = focus;
    }
    return state;
  }

  private put(state: State): void {
    this.root.replaceChildren(...state.nodes.map((n) => n.cloneNode(true)));
    const sel = this.root.ownerDocument.getSelection();
    const a = state.anchor && nodeAt(this.root, state.anchor);
    const f = state.focus && nodeAt(this.root, state.focus);
    if (sel && a) {
      sel.removeAllRanges();
      const r = this.root.ownerDocument.createRange();
      r.setStart(a.node, a.offset);
      sel.addRange(r);
      if (f) sel.extend(f.node, f.offset);
    }
  }

  private trim(): void {
    if (this.past.length > HISTORY_STEPS) this.past.splice(0, this.past.length - HISTORY_STEPS);
    let total = this.past.reduce((s, st) => s + sizeOf(st), 0);
    while (this.past.length > 1 && total > HISTORY_CHARS) total -= sizeOf(this.past.shift()!);
  }

  /** Keep the state as it is now, before a change: a block operation, a format, a paste. */
  record(): void {
    this.typing = undefined;
    this.past.push(this.now());
    this.future = [];
    this.trim();
  }

  /**
   * Keep the state before a keystroke, unless it continues a run of typing
   * of the same kind (inserting, or deleting) less than a second after the last.
   */
  typed(kind: string, at = Date.now()): void {
    const run = this.typing && this.typing.kind === kind && at - this.typing.at < 1000;
    if (!run) this.record();
    this.typing = { at, kind };
  }

  /** End a run of typing, so the next keystroke starts a step of its own (the caret moved). */
  pause(): void {
    this.typing = undefined;
  }

  undo(): boolean {
    const back = this.past.pop();
    if (!back) return false;
    this.future.push(this.now());
    this.put(back);
    this.typing = undefined;
    return true;
  }

  redo(): boolean {
    const next = this.future.pop();
    if (!next) return false;
    this.past.push(this.now());
    this.put(next);
    this.typing = undefined;
    return true;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }
}
