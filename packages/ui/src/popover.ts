/**
 * Where a floating panel goes.
 *
 * Panels are portalled to the body and positioned against the viewport, so
 * the arithmetic lives here rather than in each of the things that needs one.
 */

/** Space to leave between the menu and the edge of the window. */
const MARGIN = 8;

export interface Placement {
  left: number;
  top?: number;
  bottom?: number;
  minWidth: number;
  maxHeight: number;
}

/**
 * Put the menu under its button, or above it when there is more room there.
 * Measured against the viewport because the menu is positioned fixed.
 */
export function place(button: DOMRect): Placement {
  const below = window.innerHeight - button.bottom - MARGIN;
  const above = button.top - MARGIN;
  const openUp = below < 180 && above > below;
  const left = Math.max(
    MARGIN,
    Math.min(button.left, window.innerWidth - button.width - MARGIN),
  );
  return {
    left,
    ...(openUp
      ? { bottom: window.innerHeight - button.top + 6 }
      : { top: button.bottom + 6 }),
    minWidth: button.width,
    maxHeight: Math.max(140, (openUp ? above : below) - 6),
  };
}

export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
}


/**
 * Nudge a rendered panel back inside the window.
 *
 * place() can only clamp by the anchor's width, which is right for a menu
 * that is at least as wide as its button and wrong for a wide card hanging
 * off a narrow bar in a chart: that ran off the right edge with its last
 * column cut off. This measures what actually rendered and shifts it.
 */
export function fitInside(el: HTMLElement): void {
  const rect = el.getBoundingClientRect();
  const overRight = rect.right - (window.innerWidth - MARGIN);
  if (overRight > 0) {
    el.style.left = `${Math.max(MARGIN, rect.left - overRight)}px`;
  }
  const overLeft = MARGIN - rect.left;
  if (overLeft > 0) el.style.left = `${MARGIN}px`;
}
