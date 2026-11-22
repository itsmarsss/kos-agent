/**
 * The chosen row kept in view as the keys move it: its own scroller moved
 * just enough, below the list's sticky head, and nothing round it (the
 * panel, the page) scrolled with it, as `scrollIntoView` would.
 */

export interface Span {
  top: number;
  height: number;
}

/** Where a scroller showing `view` (its scrollTop and height) must scroll to show `row` whole below a sticky band `inset` tall; null where it already does. Both in the scroller's content coordinates. */
export function revealTop(view: Span, row: Span, inset = 0): number | null {
  if (row.top < view.top + inset) return Math.max(0, row.top - inset);
  if (row.top + row.height > view.top + view.height) return row.top + row.height - view.height;
  return null;
}

/** Scroll `row`'s own scroller in the Finder (a column, or the main view) so it shows whole. */
export function reveal(row: HTMLElement): void {
  const scroller = row.closest<HTMLElement>(".finder-column, .finder-main");
  if (!scroller) return;
  const box = scroller.getBoundingClientRect();
  const at = row.getBoundingClientRect();
  const head = scroller.querySelector<HTMLElement>(":scope > .finder-list > .finder-list-head");
  const top = revealTop({ top: scroller.scrollTop, height: scroller.clientHeight }, { top: at.top - box.top - scroller.clientTop + scroller.scrollTop, height: at.height }, head?.offsetHeight ?? 0);
  if (top !== null) scroller.scrollTop = top;
}
