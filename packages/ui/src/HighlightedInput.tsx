import { useEffect, useRef, type ReactElement, type ReactNode } from "react";

/**
 * A textarea whose references are coloured as they are typed.
 *
 * A textarea cannot style its own contents, so the text is drawn twice: once
 * in a div underneath that carries the colour, and once in the textarea on top
 * with transparent text and a visible caret. The two only stay aligned if they
 * share every property that affects layout, which is why the mirror inherits
 * font, padding and wrapping rather than restating them.
 */

const MENTION =
  /@(?:project|page|file|schedule|chat|site|agent):(?:\[[^\]]+\]|[A-Za-z0-9._/-]*[A-Za-z0-9_/-])/g;
/*
 * Any word-shaped slash at the very start of the message. Deliberately not a
 * list of the commands: this file kept its own copy, so /compact and /clear
 * existed everywhere except here and were the only ones typed in plain white.
 * The autocomplete already reads the real list from the server and is the
 * thing that says whether a command exists; this only has to colour the shape
 * of one.
 */
const COMMAND = /^\s*\/[a-z][a-z-]*\b/i;

interface Piece {
  text: string;
  kind?: string;
}

/** Split text into plain runs and reference runs, in order. */
export function highlightPieces(text: string): Piece[] {
  const pieces: Piece[] = [];
  let at = 0;

  const command = COMMAND.exec(text);
  if (command) {
    pieces.push({ text: command[0], kind: "command" });
    at = command[0].length;
  }

  const rest = text.slice(at);
  let last = 0;
  for (const match of rest.matchAll(MENTION)) {
    const index = match.index ?? 0;
    if (index > last) pieces.push({ text: rest.slice(last, index) });
    const kind = match[0].slice(1, match[0].indexOf(":"));
    pieces.push({ text: match[0], kind });
    last = index + match[0].length;
  }
  if (last < rest.length) pieces.push({ text: rest.slice(last) });
  return pieces;
}

export function HighlightedInput({
  value,
  textareaRef,
  children,
}: {
  value: string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  /** The textarea itself, so the caller keeps ownership of its handlers. */
  children: ReactNode;
}): ReactElement {
  const mirror = useRef<HTMLDivElement>(null);

  // The mirror follows the textarea's scroll, or a long message drifts out of
  // register the moment it scrolls.
  useEffect(() => {
    const ta = textareaRef.current;
    const el = mirror.current;
    if (!ta || !el) return;
    const sync = (): void => {
      el.scrollTop = ta.scrollTop;
      el.scrollLeft = ta.scrollLeft;
    };
    sync();
    ta.addEventListener("scroll", sync);
    return () => ta.removeEventListener("scroll", sync);
  }, [textareaRef, value]);

  return (
    <div className="hl">
      <div className="hl-mirror" ref={mirror} aria-hidden="true">
        {highlightPieces(value).map((piece, i) =>
          piece.kind ? (
            <span key={i} className={`hl-ref hl-ref--${piece.kind}`}>
              {piece.text}
            </span>
          ) : (
            <span key={i}>{piece.text}</span>
          ),
        )}
        {/* A trailing newline has no height of its own, so the mirror would be
            one line shorter than the textarea and scroll out of step. */}
        {"​"}
      </div>
      {children}
    </div>
  );
}
