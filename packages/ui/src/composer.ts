import { useEffect, useRef, type KeyboardEvent, type RefObject } from "react";

/** The composer after a send that failed: the words back, unless the owner has typed something new since. */
export function backInComposer(now: string, sent: string): string {
  return now.trim() ? now : sent;
}

/**
 * Enter sends, Shift+Enter starts a new line.
 *
 * This is what every chat surface does, so anything else is a small daily
 * surprise. IME composition is excluded: pressing Enter to accept a candidate
 * would otherwise fire off a half-typed message.
 */
export function composerKeyDown(
  event: KeyboardEvent<HTMLTextAreaElement>,
  send: () => void,
): void {
  if (event.key !== "Enter") return;
  if (event.shiftKey) return;
  if (event.nativeEvent.isComposing) return;
  event.preventDefault();
  send();
}

/**
 * Keep a scroller pinned to the bottom while the reader is already there, and
 * leave it alone once they scroll up to read something.
 *
 * A one-shot scroll after render is not enough: transcripts grow taller after
 * first layout as code blocks, tool calls and markdown settle, so the scroll
 * lands partway up. Watching the content's size instead of guessing at timing
 * survives all of that.
 */
export function useStickToBottom<T extends HTMLElement>(
  ref: RefObject<T | null>,
  deps: unknown[],
  /**
   * What opening at the newest message is keyed on: the conversation, and
   * a message of the owner's going out. Keyed on everything watched, the
   * reset ran on every streamed delta, turned the following back on and
   * snapped the view down, so nobody could scroll up while a reply was
   * being written.
   */
  openOn: unknown = deps[0],
): void {
  const stick = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const atBottom = (): boolean =>
      el.scrollHeight - el.scrollTop - el.clientHeight < 48;

    /*
     * Only the reader's own scrolling decides whether to follow. A snap to
     * the bottom fires a scroll event of its own, which read as "at the
     * bottom, keep following"; and a streamed reply mutates every few
     * milliseconds, so a wheel tick upward was undone by the next snap
     * before the next tick arrived. The owner could not scroll up while a
     * reply was being written. A snap is marked and its event ignored, and
     * a wheel or touch upward lets go at once.
     */
    let snapping = false;
    const onScroll = (): void => {
      if (snapping) {
        snapping = false;
        return;
      }
      stick.current = atBottom();
    };
    const onWheel = (e: WheelEvent): void => {
      if (e.deltaY < 0) stick.current = false;
    };
    const onTouch = (): void => {
      stick.current = false;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchmove", onTouch, { passive: true });

    const follow = (): void => {
      if (!stick.current || atBottom()) return;
      snapping = true;
      el.scrollTop = el.scrollHeight;
    };
    const observer = new ResizeObserver(follow);
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);

    // A streamed turn arrives as a child that did not exist when the observer
    // was set up, and a scroller of fixed height never changes size as its
    // content grows, so neither of the above notices it. Watching the subtree
    // does: without this the reply streamed in below the fold.
    const mutations = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (node instanceof Element) observer.observe(node);
        }
      }
      follow();
    });
    mutations.observe(el, { childList: true, subtree: true, characterData: true });

    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchmove", onTouch);
      observer.disconnect();
      mutations.disconnect();
    };
    // Re-observe when the children change, so new turns are watched too.
  }, [ref, ...deps]);

  // A conversation opens at its newest message, not its oldest; so does a
  // message the owner just sent.
  useEffect(() => {
    stick.current = true;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [ref, openOn]);
}

/**
 * Grow a textarea with what is typed, up to a ceiling.
 *
 * A fixed three-row box means a long message is written through a slot, and a
 * one-word message reserves three rows of a thread that could have used them.
 */
export function useAutoGrow(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  maxRows = 12,
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Reset first: without it the box can only ever get taller.
    el.style.height = "auto";
    const line = parseFloat(getComputedStyle(el).lineHeight || "20") || 20;
    const max = line * maxRows;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [ref, value, maxRows]);
}

/** Something in a draft that looks like a secret, where it is, and what it would be kept as. */
export interface FoundSecret {
  kind: "login" | "card" | "apikey";
  field: "password" | "number" | "token";
  /** What it is, for the offer: "a card number". */
  what: string;
  value: string;
  /** The span of the draft it takes, to take it out. */
  start: number;
  end: number;
}

/** Whether a run of digits passes the Luhn check every card number does. */
export function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

const KEY_PATTERNS: readonly { re: RegExp; what: string }[] = [
  { re: /\bsk-[A-Za-z0-9_-]{16,}/g, what: "an API key" },
  { re: /\bghp_[A-Za-z0-9]{20,}/g, what: "a GitHub token" },
  { re: /\bxox[a-z]-[A-Za-z0-9-]{10,}/g, what: "a Slack token" },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, what: "an AWS key" },
];

/**
 * The first thing in a draft that looks like a secret: a card number (13
 * to 19 digits, spaced or dashed, Luhn-valid), a key by its prefix, or a
 * "password: ..." line. The composer offers to keep it as a secret instead
 * of sending it; the host masks values it stores either way.
 */
export function detectSecret(text: string): FoundSecret | null {
  const found: FoundSecret[] = [];
  for (const m of text.matchAll(/(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g)) {
    const digits = m[0].replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) {
      found.push({ kind: "card", field: "number", what: "a card number", value: digits, start: m.index, end: m.index + m[0].length });
      break;
    }
  }
  for (const { re, what } of KEY_PATTERNS) {
    const m = re.exec(text);
    re.lastIndex = 0;
    if (m) found.push({ kind: "apikey", field: "token", what, value: m[0], start: m.index, end: m.index + m[0].length });
  }
  // A sentence's own punctuation after it ("password: hunter2.") is not the password's.
  const pw = /\bpass(?:word|wd)\s*[:=]\s*(\S+?)[.,;:!?)\]"']*(?=\s|$)/i.exec(text);
  if (pw) found.push({ kind: "login", field: "password", what: "a password", value: pw[1]!, start: pw.index, end: pw.index + pw[0].lastIndexOf(pw[1]!) + pw[1]!.length });
  found.sort((a, b) => a.start - b.start);
  return found[0] ?? null;
}

/** The draft with what was found taken out, the gap it leaves closed. */
export function withoutSecret(text: string, found: FoundSecret): string {
  const before = text.slice(0, found.start).replace(/[ \t]+$/, "");
  const after = text.slice(found.end).replace(/^[ \t]+/, "");
  return before && after && !/\n$/.test(before) && !/^\n/.test(after) ? `${before} ${after}` : `${before}${after}`;
}
