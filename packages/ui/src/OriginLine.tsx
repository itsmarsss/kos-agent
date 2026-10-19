import type { ReactElement } from "react";

import type { MessageOrigin } from "./api.js";
import { hrefFor } from "./routes.js";

/**
 * Where a message came from, in words: "via #leetcode on Discord", "Ana, a
 * guest in #leetcode on Discord", "schedule · LeetCode Daily", "sent by
 * Workout Tracker". The dashboard itself is never named; a message typed
 * here is the ordinary case and carries no origin at all.
 */
export function originWords(origin: MessageOrigin): { text: string; href?: string } | null {
  const { via, room, from } = origin;
  const surface = via === "discord" ? "Discord" : via === "imessage" ? "iMessage" : via === "sms" ? "SMS" : via === "dashboard" ? "" : via;
  const where = !room
    ? surface
    : room.kind === "dm"
      ? `${surface} DM`.trim()
      : room.name
        ? `${room.kind === "thread" ? "thread " : "#"}${room.name}${surface ? ` on ${surface}` : ""}`
        : surface;
  if (from?.kind === "guest") return { text: `${from.name}, a guest${where ? ` in ${where}` : ""}` };
  if (from?.kind === "schedule") return { text: `schedule · ${from.name}`, ...(from.id ? { href: hrefFor({ name: "crons", job: from.id }) } : {}) };
  if (from?.kind === "chat") return { text: `sent by ${from.name}`, ...(from.id ? { href: hrefFor({ name: "chats", id: from.id }) } : {}) };
  if (!where || via === "dispatch") return null;
  return { text: `via ${where}` };
}

/** The line under an owner bubble that says where the words came from. */
export function OriginLine({ origin }: { origin: MessageOrigin }): ReactElement | null {
  const words = originWords(origin);
  if (!words) return null;
  return words.href ? (
    <a className="turn-via" href={words.href}>
      {words.text}
    </a>
  ) : (
    <span className="turn-via">{words.text}</span>
  );
}
