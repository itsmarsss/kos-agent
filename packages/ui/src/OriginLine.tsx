import type { ReactElement } from "react";

import type { MessageOrigin } from "./api.js";
import { hrefFor } from "./routes.js";

/**
 * Where a message came from, in words: "via #leetcode on Discord", "Ana, a
 * guest in #leetcode on Discord", "schedule · LeetCode Daily", "sent by
 * Workout Tracker". The dashboard itself is never named; a message typed
 * here is the ordinary case and carries no origin at all.
 */
export function originWords(origin: MessageOrigin): { text: string; href?: string; room?: string } | null {
  const { via, room, from } = origin;
  const surface = via === "discord" ? "Discord" : via === "imessage" ? "iMessage" : via === "sms" ? "SMS" : via === "dashboard" ? "" : via;
  // The room's own words, kept apart so the line can link them.
  const roomWords = room && room.kind !== "dm" && room.name ? `${room.kind === "thread" ? "thread " : "#"}${room.name}` : "";
  const where = !room ? surface : room.kind === "dm" ? `${surface} DM`.trim() : roomWords ? `${roomWords}${surface ? ` on ${surface}` : ""}` : surface;
  const named = roomWords ? { room: roomWords } : {};
  if (from?.kind === "guest") return { text: `${from.name}, a guest${where ? ` in ${where}` : ""}`, ...named };
  if (from?.kind === "schedule") return { text: `schedule · ${from.name}`, ...(from.id ? { href: hrefFor({ name: "crons", job: from.id }) } : {}) };
  if (from?.kind === "chat") return { text: `sent by ${from.name}`, ...(from.id ? { href: hrefFor({ name: "chats", id: from.id }) } : {}) };
  if (!where || via === "dispatch") return null;
  return { text: `via ${where}`, ...named };
}

/**
 * The line under an owner bubble that says where the words came from. The
 * room named in it, a channel or a thread, is a link to it on Discord when
 * the page can work out where it is: a channel by name, a thread by its id.
 */
export function OriginLine({ origin, linkFor }: { origin: MessageOrigin; linkFor?: (room: NonNullable<MessageOrigin["room"]>) => string | undefined }): ReactElement | null {
  const words = originWords(origin);
  if (!words) return null;
  if (words.href) {
    return (
      <a className="turn-via" href={words.href}>
        {words.text}
      </a>
    );
  }
  const href = origin.room && words.room ? linkFor?.(origin.room) : undefined;
  if (!href || !words.room) return <span className="turn-via">{words.text}</span>;
  const at = words.text.indexOf(words.room);
  return (
    <span className="turn-via">
      {words.text.slice(0, at)}
      <a href={href} target="_blank" rel="noopener noreferrer">
        {words.room}
      </a>
      {words.text.slice(at + words.room.length)}
    </span>
  );
}
