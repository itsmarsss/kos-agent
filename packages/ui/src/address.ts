/**
 * What the address bar does with what was typed.
 *
 * An address goes where it says; words go to the search. The line between
 * them is the browser's own: a scheme, or something with a dot and no
 * spaces, is an address, and "localhost" is one too.
 */
export function toAddress(typed: string, search: string): string {
  const text = typed.trim();
  if (!text) return "";
  // A scheme with slashes, or one of the browser's own: as typed.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(about|chrome|chrome-extension|file|data|view-source):/i.test(text)) return text;
  if (/\s/.test(text)) return search.replace("%s", encodeURIComponent(text));
  const host = text.split(/[/?#]/)[0] ?? "";
  // The machine itself is reached without TLS; anything with a dot is a site.
  if (/^(localhost|127\.0\.0\.1|\d{1,3}(\.\d{1,3}){3})(:\d+)?$/i.test(host)) return `http://${text}`;
  if (/^[^\s.]+(\.[^\s.]+)+(:\d+)?$/.test(host)) return `https://${text}`;
  return search.replace("%s", encodeURIComponent(text));
}

/** A tab's name where there is room for one line: its title, else its host. */
export function tabName(tab: { title: string; url: string }): string {
  // Chrome titles a blank page "about:blank"; nobody else would.
  if (!tab.url || tab.url === "about:blank") return "blank tab";
  if (tab.title.trim()) return tab.title.trim();
  try {
    return new URL(tab.url).host || tab.url;
  } catch {
    return tab.url;
  }
}
