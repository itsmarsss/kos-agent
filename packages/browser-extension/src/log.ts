import type { Kept } from "./update.js";

/**
 * What the extension did, kept for the owner to copy and send when
 * something went wrong: each KOS's line, pairing, and each session asked,
 * allowed, paused and ended. Tasks are left out. Kept in session storage, so
 * it outlives the worker's sleeps, and its newest lines in local storage too,
 * so a reload of the extension or of Chrome, where things most often went
 * wrong, does not take them with it.
 */

const KEY = "log";
/** The lines session storage keeps. */
export const KEEP = 400;
/** The most local storage keeps, in characters: the newest lines that fit. */
export const KEEP_LOCAL_CHARS = 40_000;
const SAVE_MS = 500;

export class ExtensionLog {
  private lines: string[] = [];
  private loaded: Promise<void> | undefined;
  private saving: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly session: Kept,
    private readonly local: Kept,
    private readonly now: () => Date = () => new Date(),
  ) {}

  note(text: string): void {
    this.lines.push(`${this.now().toISOString().slice(11, 19)} ${text}`);
    if (this.lines.length > KEEP) this.lines.splice(0, this.lines.length - KEEP);
    clearTimeout(this.saving);
    this.saving = setTimeout(() => void this.save(), SAVE_MS);
  }

  async recent(): Promise<string> {
    await this.load();
    return this.lines.length ? this.lines.join("\n") : "Nothing logged yet.";
  }

  /** Kept in both: session storage whole, local storage the newest that fit. */
  async save(): Promise<void> {
    clearTimeout(this.saving);
    await this.load();
    await this.session.set(KEY, this.lines);
    await this.local.set(KEY, newest(this.lines, KEEP_LOCAL_CHARS));
  }

  /** What was kept, before what was said since: this session's, else what local storage kept from before Chrome or the extension started again. */
  private load(): Promise<void> {
    this.loaded ??= (async () => {
      const kept = lines(await this.session.get(KEY));
      const old = kept.length ? kept : lines(await this.local.get(KEY));
      this.lines = [...old, ...this.lines].slice(-KEEP);
    })();
    return this.loaded;
  }
}

/** The newest lines whose characters together fit in `max`. */
export function newest(all: string[], max: number): string[] {
  let size = 0;
  let from = all.length;
  while (from > 0 && size + all[from - 1]!.length + 1 <= max) size += all[--from]!.length + 1;
  return all.slice(from);
}

const lines = (v: unknown): string[] => (Array.isArray(v) ? v.filter((l): l is string => typeof l === "string") : []);

/** A chrome.storage area as the log keeps it. */
const areaOf = (of: chrome.storage.StorageArea): Kept => ({ get: async (key) => (await of.get(key))[key], set: (key, value) => of.set({ [key]: value }) });

let log: ExtensionLog | undefined;
const theLog = (): ExtensionLog => (log ??= new ExtensionLog(areaOf(chrome.storage.session), areaOf(chrome.storage.local)));

export const note = (text: string): void => theLog().note(text);
export const recent = (): Promise<string> => theLog().recent();
/** Kept now, not in a moment: the worker is about to go (a reload). */
export const saveLog = (): Promise<void> => theLog().save();
