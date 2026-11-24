import { useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";

/**
 * When something long is folded: past `pastLines` of its own lines or
 * `pastChars` characters of its text, whichever comes first, it shows its
 * first `lines`. It is never folded to hide less than `MIN_HIDDEN_LINES`,
 * so Show more always opens more than a line or two.
 */
export interface FoldRule {
  /** Lines shown while folded. */
  lines: number;
  /** Folded once drawn taller than this many lines. */
  pastLines: number;
  /** Folded once its text is longer than this. */
  pastChars: number;
}

/** The fewest lines a fold may hide: hiding one line behind a button costs more than it saves. */
export const MIN_HIDDEN_LINES = 3;

/** Whether something drawn `drawnLines` tall, of `chars` characters, folds by `rule`, and how many lines it then hides. */
export function foldOf(rule: FoldRule, drawnLines: number, chars: number): { folds: boolean; hidden: number } {
  const hidden = Math.max(0, Math.ceil(drawnLines - rule.lines));
  const long = drawnLines > rule.pastLines || chars > rule.pastChars;
  return { folds: long && hidden >= MIN_HIDDEN_LINES, hidden };
}

/** Lines in the plural or not: "1 more line", "14 more lines". */
const moreLines = (n: number): string => `${n} more line${n === 1 ? "" : "s"}`;

/**
 * Something long drawn to its first lines under a fade, with Show more
 * under it and Show less once open. Measured as drawn, so a message is
 * folded by the lines it takes at this width, and measured again when the
 * width changes. Show more says how much it hides to a screen reader, and
 * the focus reaching something under the fold (a link, a code block's Copy)
 * opens it, so nothing folded away is out of the keyboard's reach.
 *
 * `open` and `onOpen` let the caller keep the choice, as a thread keeps it
 * per message while the page is open; left out, the fold keeps its own.
 */
export function Fold({
  rule,
  chars,
  what = "the message",
  open: openProp,
  onOpen,
  children,
}: {
  rule: FoldRule;
  /** The text's length, for `pastChars`. */
  chars: number;
  /** What is folded, for the button's words to a screen reader: "Show more of your message, 14 more lines". */
  what?: string;
  open?: boolean;
  onOpen?: (open: boolean) => void;
  children: ReactNode;
}): ReactElement {
  const body = useRef<HTMLDivElement>(null);
  const id = useId();
  const [own, setOwn] = useState(false);
  const open = openProp ?? own;
  const setOpen = (next: boolean): void => {
    setOwn(next);
    onOpen?.(next);
  };
  const [fold, setFold] = useState<{ folds: boolean; hidden: number; line: number }>({ folds: false, hidden: 0, line: 0 });

  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const measure = (): void => {
      const style = getComputedStyle(el);
      const size = parseFloat(style.fontSize) || 16;
      const line = parseFloat(style.lineHeight) || size * 1.5;
      const { folds, hidden } = foldOf(rule, el.scrollHeight / line, chars);
      setFold((was) => (was.folds === folds && was.hidden === hidden && was.line === line ? was : { folds, hidden, line }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    // The width, not the height: the height is the fold's own doing.
    let width = el.clientWidth;
    const watch = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      measure();
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, [rule, chars]);

  const folded = fold.folds && !open;
  return (
    <div className={`kos-fold${folded ? " is-folded" : ""}`}>
      <div
        ref={body}
        id={id}
        className="kos-fold-body"
        style={folded ? { maxHeight: `${rule.lines * fold.line}px` } : undefined}
        onFocus={(e) => {
          if (folded && e.target !== e.currentTarget) setOpen(true);
        }}
      >
        {children}
      </div>
      {fold.folds && (
        <button
          type="button"
          className="kos-fold-toggle"
          aria-expanded={open}
          aria-controls={id}
          aria-label={open ? `Show less of ${what}` : `Show more of ${what}, ${moreLines(fold.hidden)}`}
          onClick={() => setOpen(!open)}
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}
