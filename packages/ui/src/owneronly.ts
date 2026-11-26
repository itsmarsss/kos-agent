/** The line under the switch: the channels yours alone now, or why there are none. */
export function ownerOnlyWords(r: { connected: boolean; channels: { name: string }[]; blocked?: string }): string {
  if (!r.connected) return "No Discord server is connected, so only messages to you post unasked.";
  if (r.blocked) return r.blocked;
  if (r.channels.length === 0) return "No channel on the server is yours alone right now.";
  return `Yours alone right now: ${r.channels.map((c) => `#${c.name}`).join(", ")}.`;
}
