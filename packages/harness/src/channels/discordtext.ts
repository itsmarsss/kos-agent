import { outsideCode } from "./mentions.js";

/** A bare url, not already in angle brackets and not the target of a masked link; a bracket made literal is neither. */
const BARE_URL = /(?:(?<![<(])|(?<=\\[<(]))https?:\/\/[^\s<>()\]\\]+/g;
/** A masked link whose target is not yet in angle brackets. */
const MASKED_LINK = /\]\((https?:\/\/[^\s<>()]+)\)/g;

/**
 * Every link in angle brackets, so Discord draws no preview card for it.
 *
 * A preview is Discord fetching the page and showing a title, a picture and
 * a snippet of it under KOS's words: a denied fetch of a wiki page came back
 * decorated with the wiki's own card. KOS links to pages it was told about
 * and to pages an agent read, neither of which should get to put a card in
 * the owner's DM, and Discord's crawler should not be visiting them on
 * KOS's behalf either. Code is left alone: nothing in it is a link.
 */
export function noPreviews(text: string): string {
  return outsideCode(text, (part) => part.replace(MASKED_LINK, "](<$1>)").replace(BARE_URL, "<$&>"));
}

/**
 * "Run: rm -rf build (in /w)" is a verb and a thing. The verb reads as a
 * sentence; the thing is a command, a path or a query, and goes in a code
 * block, where Discord leaves it alone. A summary with no such split is all
 * sentence.
 */
export function splitSummary(summary: string): { head: string; body?: string } {
  const i = summary.indexOf(": ");
  if (i > 0 && i <= 24) return { head: summary.slice(0, i), body: summary.slice(i + 2) };
  return { head: summary };
}

/** A line cut to fit by its middle, so its end always shows: the end of a command is where it hides what it does. */
export function cut(line: string, max: number): string {
  if (line.length <= max) return line;
  const tail = Math.floor((max - 1) * 0.4);
  return `${line.slice(0, max - 1 - tail)}…${line.slice(line.length - tail)}`;
}

/** An instant as Discord's own token, drawn on the reader's clock: `t` a time, `R` relative and kept current by Discord. */
export function discordTime(ms: number, style: "t" | "R" | "f" = "t"): string {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

/** Hosts only the machine KOS runs on can open: a link to one is no link from a phone. */
const LOOPBACK = /^(localhost|127(?:\.\d+){3}|\[::1\]|0\.0\.0\.0)$/i;

/**
 * Where on the dashboard a path opens, as a link Discord can hand to any of
 * the owner's devices: the public or LAN address. Undefined for none, or for
 * an address only this machine reaches.
 */
export function reachableUrl(base: string | undefined, hash: string): string | undefined {
  if (!base) return undefined;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return undefined;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || LOOPBACK.test(url.hostname)) return undefined;
  return `${base.replace(/\/+$/, "")}/${hash}`;
}
