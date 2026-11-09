/**
 * The owner's settings for this Chrome, kept in this Chrome.
 *
 * The same choices KOS for Mac offers on a Mac, where a browser has them:
 * the longest session, how long the ask waits, the idle limit, what of the
 * owner's hand pauses KOS, whether it connects when Chrome opens, the time
 * left on the icon, the sites KOS never sees, per KOS whether it asks
 * first, and the theme. Nothing KOS sends reaches them; only the
 * extension's own pages change them, and what is stored is read through
 * here, so a bad value is the default rather than a surprise.
 */

import { isThemeMode, type ThemeMode } from "@kos/shared";

/** What of the owner's own hand on a KOS tab pauses KOS: clicks and keys (the default, as on the Mac), or scrolling too. */
export type Takeover = "anyInput" | "clicksAndKeys";

/** How the extension's pages and the bar on a page are drawn: as the dashboard is (the default), or this Chrome's own choice. */
export type ThemeChoice = "dashboard" | ThemeMode;

export const THEME_CHOICES: readonly ThemeChoice[] = ["dashboard", "light", "dark", "system"];

/** Where the worker keeps the mode the last KOS to speak sent, in chrome.storage.local. */
export const SENT_THEME_KEY = "dashboardTheme";

/** The mode a choice draws, given what KOS last sent: the system's before anything has been. */
export function themeOf(choice: ThemeChoice, sent: unknown): ThemeMode {
  if (choice !== "dashboard") return choice;
  return isThemeMode(sent) ? sent : "system";
}

export interface ExtensionSettings {
  /** The longest a session may run, whatever KOS asks for. */
  longestMinutes: number;
  /** How long the ask waits for an answer before it is a no. */
  promptWaitSeconds: number;
  /** How long a session may sit with nothing asked of it before it ends. */
  idleMinutes: number;
  takeover: Takeover;
  /** Each KOS dials when Chrome opens; off, it waits for Connect. */
  connectOnStart: boolean;
  /** The time a session has left, on the KOS icon. */
  timeOnIcon: boolean;
  /** Sites KOS never opens, never acts on and never sees: hosts, each with its subdomains. */
  hiddenSites: string[];
  /** Per KOS, by this Chrome's device id there: false lets that KOS's approval queue decide. */
  askFirst: Record<string, boolean>;
  theme: ThemeChoice;
}

export const CHOICES = {
  longestMinutes: [15, 30, 60, 120, 240, 480],
  promptWaitSeconds: [30, 60, 120, 300],
  idleMinutes: [1, 3, 5, 10, 15],
} as const;

/** Password managers' web vaults, hidden from the start, as KOS for Mac hides the apps. */
export const DEFAULT_HIDDEN = ["1password.com", "bitwarden.com", "lastpass.com", "dashlane.com", "keepersecurity.com"];

export const DEFAULTS: ExtensionSettings = {
  longestMinutes: 120,
  promptWaitSeconds: 60,
  idleMinutes: 5,
  takeover: "clicksAndKeys",
  connectOnStart: true,
  timeOnIcon: true,
  hiddenSites: DEFAULT_HIDDEN,
  askFirst: {},
  theme: "dashboard",
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const oneOf = (choices: readonly number[], v: unknown, fallback: number): number => (typeof v === "number" && choices.includes(v) ? v : fallback);

/** Settings from what was stored, each value checked, each missing one the default. */
export function readSettings(raw: unknown): ExtensionSettings {
  const r = isRecord(raw) ? raw : {};
  const askFirst: Record<string, boolean> = {};
  if (isRecord(r["askFirst"])) for (const [k, v] of Object.entries(r["askFirst"])) if (typeof v === "boolean") askFirst[k] = v;
  const sites = Array.isArray(r["hiddenSites"]) ? r["hiddenSites"].filter((s): s is string => typeof s === "string").map(siteOf).filter((s): s is string => !!s) : DEFAULTS.hiddenSites;
  return {
    longestMinutes: oneOf(CHOICES.longestMinutes, r["longestMinutes"], DEFAULTS.longestMinutes),
    promptWaitSeconds: oneOf(CHOICES.promptWaitSeconds, r["promptWaitSeconds"], DEFAULTS.promptWaitSeconds),
    idleMinutes: oneOf(CHOICES.idleMinutes, r["idleMinutes"], DEFAULTS.idleMinutes),
    takeover: r["takeover"] === "anyInput" ? "anyInput" : "clicksAndKeys",
    connectOnStart: typeof r["connectOnStart"] === "boolean" ? r["connectOnStart"] : DEFAULTS.connectOnStart,
    timeOnIcon: typeof r["timeOnIcon"] === "boolean" ? r["timeOnIcon"] : DEFAULTS.timeOnIcon,
    hiddenSites: [...new Set(sites)],
    askFirst,
    theme: THEME_CHOICES.find((t) => t === r["theme"]) ?? DEFAULTS.theme,
  };
}

/** Whether a KOS asks here before each session: yes unless the owner said otherwise for it. */
export function asksFirst(settings: ExtensionSettings, kos: string): boolean {
  return settings.askFirst[kos] ?? true;
}

/**
 * What the owner typed or the tab is, as a site to hide: its host, lower
 * case, without a leading `www.` or `*.`, since a site is hidden with every
 * subdomain. Nothing when it is not a site.
 */
export function siteOf(text: string): string | undefined {
  const typed = text.trim().toLowerCase();
  if (!typed) return undefined;
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(typed) ? typed : `https://${typed}`).hostname;
  } catch {
    return undefined;
  }
  host = host.replace(/^\*\./, "").replace(/^www\./, "").replace(/\.$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || host === "localhost" ? host : undefined;
}

/** Whether a page's address is on a hidden site, or a subdomain of one. */
export function isHidden(url: string, sites: readonly string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return sites.some((site) => host === site || host.endsWith(`.${site}`));
}
