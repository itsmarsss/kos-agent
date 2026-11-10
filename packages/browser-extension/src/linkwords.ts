import type { Tone } from "@kos/kit";

import type { LinkState } from "./link.js";

/**
 * A KOS's line in words, the same in the popup's head, its card and the
 * side panel: a word for the pill, its tone, and a sentence that says why.
 */

export interface LineOf {
  host: string;
  name: string;
  link: LinkState;
  detail?: string;
  held: boolean;
  askFirst: boolean;
}

export interface LinkWords {
  word: string;
  tone: Tone;
  detail: string;
}

/** Who this Chrome is to a KOS, and who decides its sessions: the card's line under the KOS, as KOS for Mac says it. */
export const asWords = (k: Pick<LineOf, "name" | "askFirst">): string => `As ${k.name} · ${k.askFirst ? "asks here first" : "its approvals decide"}`;

export function linkWords(k: LineOf): LinkWords {
  if (k.held) return { word: "Disconnected", tone: "muted", detail: "You disconnected it. The pairing stays; Connect lets it in again." };
  switch (k.link) {
    case "online":
      return { word: "Connected", tone: "ok", detail: asWords(k) };
    case "connecting":
      return { word: "Connecting", tone: "accent", detail: `Reaching ${k.host}…` };
    case "offline":
      return { word: "Can't reach KOS", tone: "warn", detail: k.detail ?? `No answer from ${k.host}. Trying again.` };
    case "unpaired":
      return { word: "Not paired", tone: "danger", detail: k.detail ?? "KOS does not take this Chrome's pairing any more. Pair again." };
    case "refused":
      return { word: "Refused", tone: "danger", detail: k.detail ?? "KOS turned this Chrome away." };
    case "error":
      return { word: "Error", tone: "danger", detail: k.detail ?? "This Chrome could not open its line to KOS." };
  }
}

/** Whether pairing again is what puts this line right. */
export const needsPairing = (k: LineOf): boolean => !k.held && k.link === "unpaired";
