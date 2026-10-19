/**
 * A Discord channel named in words: `#general`.
 *
 * The same shape on every surface. On a server the adapter sends it as
 * Discord's own `<#id>`, the dashboard draws it as a chip, and the kernel
 * tells the turn what the channel is. A `#` that is not a channel's name
 * (an issue number, a colour, `C#`, a heading, an anchor in a URL) stays
 * words: the lookbehind keeps it out of a word, a mention already made and a
 * path, and whoever renders it only treats a name they know as a channel.
 */
export const CHANNEL_TOKEN = /(?<![\w<#/&])#([A-Za-z0-9][\w-]{0,99})(?![\w-])/;

/** The channel names in a text, as written, in order and once each. */
export function channelNamesIn(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(new RegExp(CHANNEL_TOKEN.source, "g"))) {
    const name = match[1] ?? "";
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}
