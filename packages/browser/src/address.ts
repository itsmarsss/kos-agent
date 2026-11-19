/** Schemes an agent may open. Files, scripts and the browser's own pages stay out: they are not the web. */
const OPEN_SCHEMES = /^(https?:|about:blank$|data:)/i;
/** The protocols a url that passed may have, as the browser parses it. */
const OPEN_PROTOCOLS = new Set(["http:", "https:", "about:", "data:"]);

/**
 * An address as typed made into a url: a scheme kept, a bare host given
 * https (http for this machine), and anything that reaches past the web
 * (a file, a script, the browser's settings) refused.
 */
export function urlFor(raw: string): string {
  const s = raw.trim();
  if (/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?(\/|$)/i.test(s)) return `http://${s}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    if (!OPEN_SCHEMES.test(s) || !OPEN_PROTOCOLS.has(protocolOf(s))) throw new Error(`${s.split(":")[0]}: addresses are not opened; only web pages (http and https)`);
    return s;
  }
  if (/^[^\s/]+\.[^\s/]+/.test(s)) return `https://${s}`;
  throw new Error(`${s} is not an address; give a url like https://example.com`);
}

/** Whether a url is a data: one, which carries its page in itself. */
export function isDataUrl(url: string): boolean {
  return protocolOf(url) === "data:";
}

function protocolOf(url: string): string {
  try {
    return new URL(url).protocol;
  } catch {
    return "";
  }
}
