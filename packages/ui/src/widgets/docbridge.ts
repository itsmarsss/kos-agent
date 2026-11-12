import { ARTIFACT_ID_RE, type ArtifactKind } from "@kos/shared";

/**
 * What the dashboard holds a doc's kos.mention and kos.open to, before it
 * opens its artifact picker or another artifact for one. Both come from the
 * page's frame, which runs whatever the agent wrote, so neither happens
 * unless the owner's hand just pressed or typed in that frame
 * (`pressed`: revealAllowed, the gesture port within REVEAL_MS), and only
 * for a doc being shown as itself: not a page or a deck, not presenting, not
 * an older version (locked). A mention asks also that the doc be in editing,
 * as the dashboard's own head knows it, and that no other ask be open. Each
 * gate answers with the sentence the page is refused with, or undefined.
 */

export interface DocCallState {
  kind: ArtifactKind | undefined;
  locked: boolean;
  presenting: boolean;
  /** The owner pressed or typed in this frame a moment ago. */
  pressed: boolean;
}

const asDoc = (s: DocCallState, what: string): string | undefined => {
  if (s.kind !== "doc") return `only a doc can ${what}`;
  if (s.presenting) return `this doc is being presented; it ${what === "mention an artifact" ? "takes no mentions" : "opens nothing"} now`;
  if (s.locked) return "this is an older version, shown to look at: restore it to change it";
  if (!s.pressed) return `a doc can ${what} only at the owner's press`;
  return undefined;
};

/** Why a doc may not open this artifact now, or undefined. `known` says whether the owner has one by that id, when the list is to hand. */
export function openRefusal(s: DocCallState, id: unknown, known?: (id: string) => boolean): string | undefined {
  const no = asDoc(s, "open an artifact");
  if (no) return no;
  if (typeof id !== "string" || id.length > 120 || !ARTIFACT_ID_RE.test(id)) return "that is not an artifact's id";
  if (known && !known(id)) return "there is no artifact by that id";
  return undefined;
}

/** Why a doc may not ask for the artifact picker now, or undefined. */
export function mentionRefusal(s: DocCallState & { editing: boolean; asking: boolean }, at: unknown): string | undefined {
  const no = asDoc(s, "mention an artifact");
  if (no) return no;
  if (!s.editing) return "a doc mentions an artifact only while it is being edited";
  if (s.asking) return "the artifact picker is already open";
  const p = (at ?? {}) as { x?: unknown; y?: unknown };
  if (typeof p.x !== "number" || typeof p.y !== "number" || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return "a mention needs the place it is made";
  return undefined;
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Where the picker opens in the dashboard's view: the doc's place for it
 * (in the frame's own coordinates), kept inside the part of the frame the
 * owner can see, so a page cannot open it over the dashboard's own controls
 * or off the screen.
 */
export function pickerPlace(at: { x: number; y: number }, frame: Box, view: { width: number; height: number }): { x: number; y: number } {
  const left = Math.max(frame.left, 0);
  const right = Math.min(frame.right, view.width);
  const top = Math.max(frame.top, 0);
  const bottom = Math.min(frame.bottom, view.height);
  const clamp = (v: number, lo: number, hi: number): number => Math.round(Math.min(Math.max(v, lo), Math.max(lo, hi)));
  return { x: clamp(frame.left + at.x, left, right), y: clamp(frame.top + at.y, top, bottom) };
}
