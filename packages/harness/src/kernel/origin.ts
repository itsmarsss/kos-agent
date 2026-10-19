import type { Guest } from "../channels/types.js";
import type { MessageFrom, MessageOrigin, MessageRoom } from "../models/types.js";

/**
 * Where a turn's message came from, as the transcript will say it.
 *
 * The owner typing on the dashboard is the ordinary case and gets no
 * origin at all, so a label only ever marks the exception: a surface, a
 * room on it, a guest, a schedule, the chat that dispatched it.
 */
export function originOf(opts: { channel?: string; via?: string; room?: MessageRoom; guest?: Guest; from?: MessageFrom }): MessageOrigin | undefined {
  const via = opts.via ?? opts.channel;
  const from: MessageFrom | undefined = opts.guest ? { kind: "guest", name: opts.guest.name, id: opts.guest.id } : opts.from;
  if ((!via || via === "dashboard") && !from && !opts.room) return undefined;
  return {
    via: via ?? "dashboard",
    ...(opts.room ? { room: opts.room } : {}),
    ...(from ? { from } : {}),
  };
}
