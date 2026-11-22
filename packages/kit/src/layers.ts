/**
 * The sheets open over the page: a dialog over a drawer, a confirm over the
 * dialog. Only the top one keeps the tab key and hears Escape, so one Escape
 * shuts one sheet and a trap underneath never pulls the focus back out of
 * the one on top. On top is the one opened last, unless it holds another
 * (a sheet drawn inside one, mounted with it, opens first as React runs its
 * effects child first).
 */
interface Open {
  id: symbol;
  box: () => HTMLElement | null;
}

const open: Open[] = [];

export interface Layer {
  /** This one is the sheet on top. */
  top: () => boolean;
  /** It has shut: the one under it is on top again. */
  close: () => void;
}

export function openLayer(box: () => HTMLElement | null): Layer {
  const me: Open = { id: Symbol("sheet"), box };
  open.push(me);
  const holds = (outer: Open, inner: Open): boolean => {
    const a = outer.box();
    const b = inner.box();
    return Boolean(a && b && a !== b && a.contains(b));
  };
  return {
    top: () => {
      const at = open.indexOf(me);
      return open.every((other, i) => other === me || (!holds(me, other) && (i < at || holds(other, me))));
    },
    close: () => {
      const at = open.indexOf(me);
      if (at >= 0) open.splice(at, 1);
    },
  };
}

/** Some sheet is open: a page's own keys (a list's arrows, its letters) leave the keys to it. */
export function sheetOpen(): boolean {
  return open.length > 0;
}
