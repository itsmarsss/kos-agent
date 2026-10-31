/**
 * What the extension did, kept for the owner to copy and send when
 * something went wrong: each KOS's line, pairing, and each session asked,
 * allowed, paused and ended. Tasks are left out. Kept in session storage, so
 * it outlives the worker's sleeps and goes when Chrome closes.
 */

const KEY = "log";
const KEEP = 400;
let lines: string[] = [];
let loaded: Promise<void> | undefined;
let saving: ReturnType<typeof setTimeout> | undefined;

function load(): Promise<void> {
  loaded ??= chrome.storage.session.get(KEY).then((kept) => {
    const old = Array.isArray(kept[KEY]) ? (kept[KEY] as unknown[]).filter((l): l is string => typeof l === "string") : [];
    lines = [...old, ...lines].slice(-KEEP);
  });
  return loaded;
}

export function note(text: string): void {
  const at = new Date().toISOString().slice(11, 19);
  lines.push(`${at} ${text}`);
  if (lines.length > KEEP) lines.splice(0, lines.length - KEEP);
  clearTimeout(saving);
  saving = setTimeout(() => void load().then(() => chrome.storage.session.set({ [KEY]: lines })), 500);
}

export async function recent(): Promise<string> {
  await load();
  return lines.length ? lines.join("\n") : "Nothing logged yet.";
}
