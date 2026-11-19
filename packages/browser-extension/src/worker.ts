import { tabMap } from "@kos/browser/frames";
import { KOS_SEED, drawingOf, eyeAt, lookOf, outline, readDashboardTheme, smoothPath, type DashboardTheme, type FaceDrawing } from "@kos/shared";

import { kosAddress, parsePairing, type Pairing } from "./address.js";
import { ENDED_KEY, HELD_KEY, afterRestart, endedFor, endedWords, helloSession, readEnded, readHeld, type Ended, type HeldSession } from "./held.js";
import { forgetKeys, keepKeys, keysFor, newKeys, publicKey } from "./keys.js";
import { Link, type Hello, type LinkState } from "./link.js";
import { Lines } from "./lines.js";
import { WAITING_KEY, due, lapsed, queued, readWaiting, stopWith, withCode, type WaitingEvent } from "./waiting.js";
import { note, recent, saveLog } from "./log.js";
import { iconPixels } from "./icon.js";
import { CURSOR } from "./cursorlook.js";
import { installOverlay, type OverlayState, type PointHow } from "./overlay.js";
import { readPage } from "./page.js";
import { aimOf, middleOf } from "./pointer.js";
import { adding, readPairings, removing, replacedBy, shownOf, type Paired } from "./pairings.js";
import { CallError, PROTOCOL, fromBase64, toBase64 } from "./protocol.js";
import { changesPage, checkCommand, checkFrameCommand, forwarded, isInput, isWebPage, isWebUrl, OVERLAY_WORLD as WORLD, withoutFieldText, Worlds } from "./relay.js";
import { HandFrames } from "./handframes.js";
import { FILLED_PAGE, TAINTS_KEY, editsField, fillField, focusedOn, heldNow, heldRefusal, hiddenValues, marked, maskedShot, movedWithin, readMasks, readPut, readTaints, typesText, type Reach, type SecretPut, type Send, type Shot, type TabTaint } from "./secret.js";
import { Session, type EndReason, type PageInput } from "./session.js";
import { DEFAULTS, SENT_THEME_KEY, asksFirst, isHidden, readSettings, siteOf, themeOf, type ExtensionSettings } from "./settings.js";
import { FolderWait, ReloadGate, folderHolds, readBuild, runningBuild, type Build, type Kept, type Reloaded, type UpdateNotice } from "./update.js";

/**
 * The extension's worker: paired with one KOS or several, it answers each
 * one's calls in the tabs of a session the owner allowed, and nowhere else.
 *
 * Each KOS is its own pairing and its own line, as KOS for Mac keeps them on a
 * Mac. There is one session at a time, whichever KOS asks: Chrome has one
 * owner at the keyboard, so another KOS that asks while one works hears this
 * Chrome is busy, and only the KOS whose session it is can act in it, hears
 * its events, or ends it by going away.
 *
 * A session starts when KOS asks and the owner says yes, in a window the
 * extension opens, unless the owner left that KOS to its own approvals. KOS
 * works in a window of its own, its tabs grouped as KOS, and in tabs the
 * owner hands it from the popup. Each of those tabs is driven over Chrome's
 * debugger, with only the commands KOS's hands use, and wears the overlay.
 * The owner's own click or key in one takes it over until they hand it back.
 * A site the owner hid is never opened, acted on or reported. The session
 * ends at its time, when idle, on Stop, when the owner closes Chrome's
 * debugging bar, and when its KOS or that connection goes.
 *
 * A side panel open beside the owner's tabs is a chat with one KOS, carried
 * on that KOS's line: the owner's words go as events, the chat comes back as
 * calls. A session that chat asks for is asked in the panel, and works in
 * the tab beside it, where the owner is looking; KOS reads that tab's page
 * only when the chat asks, only while the panel is open on it, and never a
 * hidden site.
 */

/** One KOS, as the popup shows it. */
export interface KosState {
  id: string;
  url: string;
  host: string;
  name: string;
  link: LinkState;
  detail?: string;
  askFirst: boolean;
  /** The owner disconnected it: no line until Connect. */
  held: boolean;
  /** Its face, as it last sent it. */
  face?: FaceDrawing;
}

/** What the popup is told. */
export interface PopupState {
  kos: KosState[];
  /** `kos` names the KOS it is for when there are several; `beside` is the tab beside the side panel it works in. */
  session: { task: string; requester: string; until: number; paused: boolean; kos?: string; beside?: number; conversation?: string; face: FaceDrawing } | null;
  handed: number[];
  settings: Omit<ExtensionSettings, "askFirst">;
  /** The dashboard's theme and its palette as the KOS the toolbar speaks of last sent them; none before it has. */
  dashboardTheme?: DashboardTheme;
}

export interface ConsentRequest {
  id: string;
  task: string;
  requester: string;
  minutes: number;
  /** The most the owner may allow: their longest session. */
  longest: number;
  /** How long the ask waits before it is a no, in ms. */
  waitMs: number;
  /** Which KOS asks, when there are several. */
  kos?: string;
  /** The face of the KOS that asks. */
  face: FaceDrawing;
  /** Asked in a side panel beside a web page: its site, which the owner may let the session act on without asking each step. */
  site?: string;
  /** When the ask lapses unanswered, epoch ms. */
  expiresAt: number;
}

/** The owner's answer to an ask, or why there was none: they did not answer in time, or KOS took the ask back. */
interface Decided {
  allowed: boolean;
  minutes: number;
  /** Allowed with the site's steps unasked for this session. */
  site?: boolean;
  why?: "unanswered" | "withdrawn";
}

/** A side panel open in a window: the KOS it talks to, and the chat it shows. */
interface Panel {
  port: chrome.runtime.Port;
  window: number;
  kos?: string;
  conversation?: string;
}

interface Asked {
  request: ConsentRequest;
  origin: string;
  answer: (a: Decided) => void;
  window?: number;
  /** Asked in a side panel rather than a window of its own. */
  panel?: Panel;
}

/** Commands in one batch, at most. */
const BATCH_MAX = 100;
/** Refusals that are the whole batch's answer, met at any command in it. */
const WHOLE_BATCH = new Set(["paused", "no_session", "tab"]);
/** The id the selection script is registered under. */
const SELECTION_SCRIPT = "kos-selection";
/** As much of a page's text as the panel's chat reads in one go. */
const PAGE_TEXT = 60_000;
const PANEL_CALLS = new Set(["chat.show", "chat.status", "chat.ask", "chat.settled", "chat.chats", "chat.models", "chat.mentions"]);
/** What a panel asks its KOS for, passed on as it is: the chats to switch to, a switch, the models, a model. */
const PANEL_ASKS: Record<string, string> = { list: "chat.list", switch: "chat.switch", models: "chat.models", model: "chat.model", mode: "chat.mode", mentions: "chat.mentions" };

const BINDING = "kosOverlay";
const GROUP = "KOS";
/** The overlay as each frame is given it, in its own world. */
const OVERLAY_SOURCE = `(${installOverlay.toString()})(${JSON.stringify(CURSOR)})`;
/** Each tab's frames in processes of their own, which the overlay reports the owner's hand from too. */
const handFrames = new HandFrames((target, method, params) => chrome.debugger.sendCommand(target, method, params), { source: OVERLAY_SOURCE, world: WORLD, binding: BINDING });

let pairings: Paired[] = [];
let settings: ExtensionSettings = DEFAULTS;
/** The dashboard's theme of the KOS the toolbar speaks of, as the pages are told it; none before that KOS has sent one. */
let sentTheme: DashboardTheme | undefined;
/** KOS the owner disconnected, kept across the worker's sleeps. */
let held = new Set<string>();
/** This extension's build, from the stamp beside its code as Chrome loaded it; none for a build from before stamps. */
let build: Build | undefined;
/** How Chrome says it was installed. */
let installType: string | undefined;
/** The build this extension last reloaded itself into, and when, so one that comes back the same does not reload again. */
let reloaded: Reloaded | undefined;
let reloading = false;
const RELOADED_KEY = "reloaded";
/** A folder caught mid-rebuild is looked at again after this long, by one timer at a time. */
const FOLDER_AGAIN_MS = 30_000;
const folderWait = new FolderWait();
let folderTimer: ReturnType<typeof setTimeout> | undefined;
const gate = new ReloadGate();
const linkStates = new Map<string, { state: LinkState; detail?: string }>();
let session: Session | undefined;
/** The session as kept beside memory, for a worker started again and for a KOS whose line was down when it ended (held.ts). */
let lastSession: HeldSession | undefined;
/** Why the last session ended, for a side panel on its chat. */
let lastEnded: Ended | undefined;
/** The owner's Stops and decisions in a panel while their KOS was off its line, sent in order once it is back (waiting.ts); kept across the worker's restarts. */
let waitingForLine: WaitingEvent[] = [];

/** The wait for the session's KOS to come back on its line before the session ends. */
let lineWait: ReturnType<typeof setTimeout> | undefined;
/** How long a session outlives its KOS's line: shorter than KOS's own wait, so a session kept here is still kept there. */
const LINE_WAIT_MS = 10_000;
/** The KOS whose session it is, or which is asking the owner for one. */
let owner: string | undefined;
let ticker: ReturnType<typeof setInterval> | undefined;
let badgeShown = "";
/** Tabs the owner has handed KOS: they join the next session, and the live one. */
const handed = new Set<number>();
const attached = new Set<number>();
/** Each tab's overlay, by the world it runs in. */
const overlays = new Map<number, Set<number>>();
/** Each tab's worlds, as Chrome said it made them: KOS's script runs only in the page's and its hands', and only the overlay's speak for the overlay. */
const worldsOf = new Map<number, Worlds>();
/** Waits on a world being made, woken at each one. */
const worldsMade = new Set<() => void>();
/** Each KOS tab's address as it changes, so one on a hidden site tells KOS nothing. */
const tabUrls = new Map<number, string>();
/** Each KOS tab's main document, by its loader, as the debugger last heard it commit. */
const loaders = new Map<number, string>();
/** Each KOS tab's main frame, by its id. */
const mainFrames = new Map<number, string>();
/** Tabs a secret was filled into, kept in session storage: what each is held to until its document changes (secret.ts). */
let taints = new Map<number, TabTaint>();
/** Waits on a navigation to commit, woken at each one. */
const commits = new Set<() => void>();
/** Each KOS tab's requests passed on to KOS that have not ended. */
const openRequests = new Map<number, Set<string>>();
const consents = new Map<string, Asked>();
const panels = new Set<Panel>();
/** Asks to read pages, waiting on the owner in a panel. */
const reads = new Map<string, { panel: Panel; answer: (granted: boolean) => void }>();
/** The tab beside the side panel, in the session the panel's chat asked for. */
let beside: number | undefined;
/** Where the owner put the bar on KOS's tabs, and whether they folded it: the same on every tab and page of the session. */
let barPlace: Pick<OverlayState, "at" | "folded"> = {};

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const hostOf = (p: Pick<Paired, "url">): string => {
  try {
    return new URL(p.url).host;
  } catch {
    return p.url;
  }
};
const pairingOf = (id: string | undefined): Paired | undefined => pairings.find((p) => p.device === id);
/** A KOS's face: the one it last sent, else KOS's own default. */
const faceOf = (id: string | undefined): FaceDrawing => pairingOf(id)?.face ?? drawingOf(lookOf(KOS_SEED));
/** What to call a KOS to the owner, when there is more than one to tell apart. */
const kosName = (id: string | undefined): string | undefined => (pairings.length > 1 ? pairingOf(id) && hostOf(pairingOf(id)!) : undefined);

// Kept across the worker's sleeps: pairings, settings and who is held in local storage, the handed tabs and KOS's window in session storage.
async function load(): Promise<void> {
  const local = await chrome.storage.local.get(["pairings", "paired", "settings", "held", SENT_THEME_KEY, RELOADED_KEY]);
  build = await runningBuild(area(chrome.storage.session), area(chrome.storage.local), ownBuild);
  installType = (await chrome.management.getSelf().catch(() => undefined))?.installType;
  const last = local[RELOADED_KEY] as Partial<Reloaded> | undefined;
  reloaded = typeof last?.build === "string" && typeof last.at === "number" ? { build: last.build, at: last.at } : undefined;
  pairings = readPairings(local["pairings"], local["paired"]);
  if (!Array.isArray(local["pairings"]) && pairings.length) {
    await chrome.storage.local.set({ pairings });
    await chrome.storage.local.remove("paired");
    note(`moved the one pairing, ${hostOf(pairings[0]!)}, into the list`);
  }
  settings = readSettings(local["settings"]);
  sentTheme = readDashboardTheme(local[SENT_THEME_KEY]);
  held = new Set(Array.isArray(local["held"]) ? (local["held"] as unknown[]).filter((v): v is string => typeof v === "string") : []);
  const kept = await chrome.storage.session.get(["handed", "bar", HELD_KEY, ENDED_KEY, WAITING_KEY, TAINTS_KEY]);
  taints = readTaints(kept[TAINTS_KEY]);
  lastEnded = readEnded(kept[ENDED_KEY]);
  waitingForLine = readWaiting(kept[WAITING_KEY]);
  for (const tab of Array.isArray(kept["handed"]) ? (kept["handed"] as number[]) : []) handed.add(tab);
  if (typeof kept["bar"] === "object" && kept["bar"] !== null) barPlace = kept["bar"] as typeof barPlace;
  await lostAtStart(readHeld(kept[HELD_KEY]));
}

/**
 * A session the last worker held is over with it: its debugger and its
 * pages went when that worker did. Its tabs are let go of, and its KOS
 * hears why in this worker's hello.
 */
async function lostAtStart(found: HeldSession | undefined): Promise<void> {
  const after = afterRestart(found);
  if (!after || after === found) {
    lastSession = found;
    return;
  }
  note(`session ${after.id} ended: KOS for Chrome restarted; telling its KOS`);
  await Promise.all(after.tabs.map((tab) => chrome.debugger.detach({ tabId: tab }).catch(() => undefined)));
  await keepSession(after);
  if (after.conversation) await sayEnded({ conversation: after.conversation, reason: "restarted", at: Date.now() });
}

/** Why the chat's session ended, to its side panels now, and kept for one opened or found again soon after. */
async function sayEnded(ended: Ended): Promise<void> {
  lastEnded = ended;
  await chrome.storage.session.set({ [ENDED_KEY]: ended });
  for (const panel of panels) tellEnded(panel);
}

function tellEnded(panel: Panel): void {
  const ended = endedFor(lastEnded, panel.conversation, Date.now());
  if (ended) panel.port.postMessage({ type: "session.ended", conversation: ended.conversation, reason: ended.reason, words: endedWords(ended.reason) });
}

/** The session as kept beside memory, or none once its KOS knows it is over. */
async function keepSession(next: HeldSession | undefined): Promise<void> {
  lastSession = next;
  await (next ? chrome.storage.session.set({ [HELD_KEY]: next }) : chrome.storage.session.remove(HELD_KEY));
}
const ready = load();

/** A file of this extension's folder as it is on disk now, or none. */
async function ownFile(file: string): Promise<string | undefined> {
  try {
    const answer = await fetch(chrome.runtime.getURL(file), { cache: "no-store" });
    return answer.ok ? await answer.text() : undefined;
  } catch {
    return undefined;
  }
}

/** The stamp the build wrote beside this extension's code (docs/computer.md, Builds). */
async function ownBuild(): Promise<Build | undefined> {
  const text = await ownFile("build.json");
  try {
    return text ? readBuild(JSON.parse(text)) : undefined;
  } catch {
    return undefined;
  }
}

/** A chrome.storage area as the build keeper reads it. */
function area(of: chrome.storage.StorageArea): Kept {
  return { get: async (key) => (await of.get(key))[key], set: (key, value) => of.set({ [key]: value }) };
}

const savePairings = (): Promise<void> => chrome.storage.local.set({ pairings });
const saveSettings = (): Promise<void> => chrome.storage.local.set({ settings });
const saveHeld = (): Promise<void> => chrome.storage.local.set({ held: [...held] });
const saveHanded = (): Promise<void> => chrome.storage.session.set({ handed: [...handed] });
const saveTaints = (): Promise<void> => chrome.storage.session.set({ [TAINTS_KEY]: Object.fromEntries(taints) });

function hello(id: string): Hello {
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform;
  const kept = helloSession(lastSession, id);
  // Whether the owner holds it now: a Hand back pressed while the line was down is heard this way.
  const live = kept && !kept.ended && session?.info.id === kept.id ? { ...kept, paused: session.paused } : kept;
  return {
    app: { version: chrome.runtime.getManifest().version, platform: "chrome", os: platform || "unknown" },
    consent: asksFirst(settings, id) ? "device" : "kos",
    permissions: { tabs: true },
    displays: [],
    ...(build ? { build } : {}),
    ...(installType ? { install: installType } : {}),
    ...(live ? { session: live } : {}),
  };
}

/** KOS's word on this build: a newer one in its folder is reloaded into once nothing is going on. */
function updated(id: string, update: UpdateNotice): void {
  gate.told(id, update);
  if (update.reload) note(`${hostOf(pairingOf(id) ?? { url: id })}: build ${update.build!.id} is ready; reloading once nothing is going on`);
  void maybeReload();
}

/**
 * Reload into the build KOS told of, when it is due: no side panel turn, no
 * session and no ask for one. Only an unpacked extension, whose folder a
 * reload reads again; KOS hears it first, so a copy that comes back on the
 * same build is reported and not reloaded again.
 */
async function maybeReload(): Promise<void> {
  // An open side panel is busy too: a reload takes its page down under the owner, whatever it is doing.
  const busy = (): boolean => session !== undefined || owner !== undefined || consents.size > 0 || panels.size > 0;
  if (reloading || installType !== "development") return;
  const first = gate.due(busy(), reloaded);
  if (!first) return;
  // A folder being rebuilt (the build begins by removing it) is not reloaded into: it is looked at again later,
  // and after a while KOS is told it lacks the build (loaded from another folder), and settles it as still behind.
  if (!(await folderHolds(first.build, ownFile))) {
    const next = folderWait.miss(first.build);
    if (next === "give-up") {
      note(`the folder never came to hold build ${first.build}; telling KOS`);
      links.get(first.kos)?.event("update.state", { build: first.build, state: "missing" });
    } else if (next === "again" && !folderTimer) {
      note(`the folder does not hold build ${first.build} yet; looking again shortly`);
      folderTimer = setTimeout(() => {
        folderTimer = undefined;
        void maybeReload();
      }, FOLDER_AGAIN_MS);
    }
    return;
  }
  // Asked again after the waits: a session may have begun meanwhile, or KOS named another build.
  const due = gate.due(busy(), reloaded);
  if (reloading || due?.build !== first.build) return;
  reloading = true;
  reloaded = { build: due.build, at: Date.now() };
  await chrome.storage.local.set({ [RELOADED_KEY]: reloaded });
  note(`reloading into build ${due.build}`);
  const link = links.get(due.kos);
  link?.event("update.state", { build: due.build, state: "reloading" });
  await link?.sent();
  await saveLog();
  chrome.runtime.reload();
}

/** A KOS's new face, kept for when it is offline, and on the page it works in at once. */
async function showFace(id: string, face: FaceDrawing): Promise<void> {
  if (!pairingOf(id) || JSON.stringify(pairingOf(id)!.face) === JSON.stringify(face)) return;
  pairings = pairings.map((p) => (p.device === id ? { ...p, face } : p));
  await savePairings();
  await badge();
  if (owner === id) await paint();
}

/** A KOS's dashboard theme, kept with its pairing; drawn when it is the KOS the toolbar speaks of. */
async function keepTheme(id: string, theme: DashboardTheme): Promise<void> {
  if (!pairingOf(id) || sameTheme(pairingOf(id)!.theme, theme)) return;
  pairings = pairings.map((p) => (p.device === id ? { ...p, theme } : p));
  await savePairings();
  await showTheme();
}

/** The theme of the KOS the toolbar speaks of, told the pages to follow when set to, and the page KOS works in at once. */
async function showTheme(): Promise<void> {
  const theme = pairingOf(shownKos())?.theme;
  if (sameTheme(sentTheme, theme)) return;
  sentTheme = theme;
  await (theme ? chrome.storage.local.set({ [SENT_THEME_KEY]: theme }) : chrome.storage.local.remove(SENT_THEME_KEY));
  await paint();
}

function sameTheme(a: DashboardTheme | undefined, b: DashboardTheme | undefined): boolean {
  return a?.mode === b?.mode && a?.drawn === b?.drawn;
}

/** Every KOS's line, up unless the owner held it; with `unpairedToo`, one KOS no longer takes is tried again too. */
const connectAll = (unpairedToo = false): Promise<void> => lines.connectAll(pairings, unpairedToo);
const connect = (p: Paired): Promise<void> => lines.connect(p);

function lineState(p: Paired, state: LinkState, detail?: string): void {
  const id = p.device;
  const was = linkStates.get(id);
  linkStates.set(id, { state, ...(detail ? { detail } : {}) });
  if (state !== was?.state || detail !== was?.detail) note(`${hostOf(p)}: ${state}${detail ? ` (${detail})` : ""}`);
  if (state === was?.state) return;
  void badge();
  // Its turns and its word on this build are told again once it is back.
  if (state !== "online") gate.gone(id);
  // A panel open on this KOS is shown its chat as soon as there is a line to show it on.
  if (state === "online") for (const panel of panels) if (panel.kos === id) links.get(id)?.event("chat.open", {});
  if (state === "online") backOnLine(id);
  // A session lives on its connection: its KOS gone a moment is waited for, gone for good ends it; an ask it made is withdrawn.
  if (state !== "online" && state !== "connecting" && owner === id) {
    if (session && state === "offline") waitForLine(p);
    else if (session) void end("host");
    for (const asked of consents.values()) if (asked.origin === id) asked.answer({ allowed: false, minutes: 0, why: "withdrawn" });
  }
}

/** The session's KOS dropped its line: its hello says the session is still held if it is back in time; else the session ends. */
function waitForLine(p: Paired): void {
  if (lineWait) return;
  note(`${hostOf(p)}: keeping the session ${LINE_WAIT_MS / 1000} s for the line to come back`);
  lineWait = setTimeout(() => {
    lineWait = undefined;
    if (session && owner === p.device && !links.get(p.device)?.online) void end("host");
  }, LINE_WAIT_MS);
}

/** A KOS back on its line: told in its hello of the session this Chrome still holds or lost meanwhile, so what was kept to tell it is done with. */
function backOnLine(id: string): void {
  const link = links.get(id);
  // Said in the hello already; said as the event too, for a KOS that reads only that.
  if (lastSession?.kos === id && lastSession.ended) {
    link?.event("session.ended", { session: lastSession.id, reason: lastSession.ended });
    void keepSession(undefined);
  }
  const { send, rest } = due(waitingForLine, id, Date.now());
  for (const { name, data } of send) link?.event(name, data);
  if (send.length || rest.length !== waitingForLine.length) void keepWaiting(rest);
  if (owner !== id || !session) return;
  clearTimeout(lineWait);
  lineWait = undefined;
  note("the session goes on across the new line");
  // What KOS may have missed meanwhile: the owner taking over, or handing back.
  if (session.paused) tell("session.paused", { session: session.info.id, reason: "owner" });
  else tell("session.resumed", { session: session.info.id });
}

const lines = new Lines<Link>({
  keysFor,
  link: (p, keys) =>
    new Link({
      url: p.url,
      device: p.device,
      hostKey: p.hostKey,
      keys,
      hello: () => hello(p.device),
      onCall: (method, params) => answer(method, params, p.device),
      onFace: (face) => void showFace(p.device, face),
      onTheme: (theme) => void keepTheme(p.device, theme),
      onUpdate: (update) => updated(p.device, update),
      onState: (state, detail) => lineState(p, state, detail),
    }),
  wanted: (id) => !!pairingOf(id) && !held.has(id),
  stateOf: (id) => linkStates.get(id)?.state,
  setState: lineState,
});
const links = lines.links;

/** The KOS icon says a session is on, the owner has it, or how long it has left. */
function badgeText(): string {
  if (!session) return "";
  if (session.paused) return "YOU";
  if (!settings.timeOnIcon) return "ON";
  const m = Math.max(1, Math.ceil((session.info.until - Date.now()) / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`;
}

/** The KOS the toolbar speaks of, as the popup does: the one at work, else the first that is on, else the first paired. */
function shownKos(): string | undefined {
  if (session) return owner;
  return shownOf(pairings, undefined, (id) => linkStates.get(id)?.state === "online" && !held.has(id))?.device;
}

const OWN_FACE = JSON.stringify(drawingOf(lookOf(KOS_SEED)));
/** The face the icon wears now, so it is drawn again only when that changes. */
let iconFace = "";

/** The toolbar in the face of the KOS it speaks of: the packaged icon for KOS's own, else that face drawn. */
async function paintIcon(): Promise<void> {
  const face = faceOf(shownKos());
  const key = JSON.stringify(face);
  if (key === iconFace) return;
  iconFace = key;
  if (key === OWN_FACE) return chrome.action.setIcon({ path: { 16: "icon16.png", 32: "icon32.png" } });
  const drawn = { fill: face.fill, ink: face.ink, body: smoothPath(outline(face.shape)), eyes: (["l", "r"] as const).map((side) => eyeAt(side, face.shape)) };
  await chrome.action.setIcon({ imageData: { 16: iconPixels(drawn, 16), 32: iconPixels(drawn, 32) } });
}

async function badge(): Promise<void> {
  await showTheme();
  await paintIcon().catch((err: unknown) => note(`the icon was not drawn: ${err instanceof Error ? err.message : String(err)}`));
  const text = badgeText();
  badgeShown = text;
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: session?.paused ? "#e6b84d" : "#7c9cff" });
  await chrome.action.setBadgeTextColor({ color: "#0b0e14" });
  // The panels hear a session start, pause, resume or end as it happens.
  for (const panel of panels) panel.port.postMessage({ type: "state", state: popupState() });
}

/** An event for the KOS whose session it is. */
function tell(name: string, data: Record<string, unknown>): void {
  if (owner) links.get(owner)?.event(name, data);
}

// KOS's calls, each from the KOS on that line.

async function answer(method: string, params: Record<string, unknown>, origin: string): Promise<Record<string, unknown>> {
  await ready;
  switch (method) {
    case "session.begin":
      return begin(params, origin);
    case "session.end": {
      // An ask KOS takes back (the owner pressed Stop in the chat): the prompt comes down, and the ask is answered as withdrawn.
      const asked = consents.get(str(params["session"]));
      if (asked?.origin === origin) {
        asked.answer({ allowed: false, minutes: 0, why: "withdrawn" });
        return {};
      }
      live(params, origin);
      await end("host");
      return {};
    }
    case "tabs.list":
      live(params, origin);
      return { tabs: await listTabs() };
    case "tabs.open":
      live(params, origin);
      return { tab: String(await openTab(str(params["url"]) || "about:blank")) };
    case "tabs.close": {
      const s = live(params, origin);
      const tab = tabOf(s, params);
      // Not while the owner has it, nor a tab of theirs on a site hidden from KOS: those are theirs to close.
      if (s.paused) throw pausedError();
      if (handed.has(tab) || tab === beside) await refuseHidden(tab);
      await chrome.tabs.remove(tab);
      return {};
    }
    case "cdp.send":
      return relay(params, origin);
    case "cdp.batch":
      return relayAll(params, origin);
    case "page.read":
      return pageRead(params, origin);
    case "secret.fill":
      return secretFill(params, origin);
    case "secret.picture":
      return secretPicture(params, origin);
    case "tab.origins":
      return tabOrigins(params, origin);
    default:
      if (PANEL_CALLS.has(method)) {
        toPanels(method, params, origin);
        gate.heard(origin, method, params);
        void maybeReload();
        return {};
      }
      throw new CallError("bad_request", `${method} is not something this extension does`);
  }
}

/** The live session a call names, from the KOS whose session it is, or a refusal that says nothing of anyone else's. */
function live(params: Record<string, unknown>, origin: string): Session {
  if (!session || owner !== origin || params["session"] !== session.info.id) throw new CallError("no_session", "no session is live in this Chrome");
  session.touch(Date.now());
  return session;
}

function tabOf(s: Session, params: Record<string, unknown>): number {
  const tab = Number(params["tab"]);
  if (!Number.isInteger(tab) || !s.tabs.has(tab)) throw new CallError("tab", "that tab is not one KOS was given");
  return tab;
}

/** The session still the live one, and the tab still in it: either can go while a call waits (Stop, the owner taking the tab back). */
function stillIn(s: Session, tab: number): void {
  if (session !== s) throw new CallError("no_session", "no session is live in this Chrome");
  if (!s.tabs.has(tab)) throw new CallError("tab", "that tab is not one KOS was given");
}

function hiddenError(url: string): CallError {
  return new CallError("hidden_site", `${new URL(url).host} is hidden from KOS in this Chrome`);
}

async function begin(params: Record<string, unknown>, origin: string): Promise<Record<string, unknown>> {
  const id = str(params["session"]);
  if (!id) throw new CallError("bad_request", "session required");
  if (session || owner) throw new CallError("busy", owner === origin ? "KOS is already working in this Chrome" : "another KOS is using this Chrome");
  owner = origin;
  const conversation = str(params["conversation"]);
  // Asked by the chat in a side panel: asked there, and worked in the tab beside it.
  const panel = conversation ? [...panels].find((p) => p.kos === origin && p.conversation === conversation) : undefined;
  try {
    const asked = Math.min(settings.longestMinutes, Math.max(1, Math.round(Number(params["minutes"]) || 15)));
    // Asked in the panel beside a web page: that page's site may be let act without asking.
    const front = panel ? await besideTab(panel) : undefined;
    const site = front?.url ? new URL(front.url).host : undefined;
    const request: ConsentRequest = {
      id,
      task: str(params["task"]) || "a task",
      requester: str(params["requester"]) || "KOS",
      minutes: asked,
      longest: settings.longestMinutes,
      waitMs: settings.promptWaitSeconds * 1000,
      ...(kosName(origin) ? { kos: kosName(origin)! } : {}),
      face: faceOf(origin),
      ...(site ? { site } : {}),
      expiresAt: Date.now() + settings.promptWaitSeconds * 1000,
    };
    // The requester is a chat's title, the owner's words: not for a log kept on disk.
    note(`${hostOf(pairingOf(origin) ?? { url: origin })} asks for ${asked} min${conversation ? ` for chat ${conversation}` : ""}`);
    let minutes = asked;
    let alone: string | undefined;
    if (asksFirst(settings, origin)) {
      const decided = await askOwner(request, origin, panel);
      if (!decided.allowed) {
        note(decided.why === "withdrawn" ? "the ask was withdrawn" : decided.why === "unanswered" ? "not answered" : "not allowed");
        return { granted: false, ...(decided.why ? { reason: decided.why } : {}) };
      }
      minutes = decided.minutes;
      if (decided.site && site) alone = site;
    }
    // The line may have gone while the owner decided.
    if (!links.get(origin)?.online) throw new CallError("no_session", "KOS went away before the session started");
    const now = Date.now();
    const there = panel ? await besideTab(panel) : undefined;
    session = new Session({ id, task: request.task, requester: request.requester, ...(conversation ? { conversation } : {}), until: now + minutes * 60_000 }, now);
    for (const tab of handed) session.tabs.add(tab);
    if (there?.id !== undefined) {
      beside = there.id;
      session.tabs.add(there.id);
    }
    clearInterval(ticker);
    let beat = 0;
    ticker = setInterval(() => {
      const reason = session?.over(Date.now(), settings.idleMinutes * 60_000);
      if (reason) return void end(reason);
      if (badgeText() !== badgeShown) void badge();
      // The overlay goes by itself unless told the session is still on.
      if (++beat % 3 === 0) for (const tab of overlays.keys()) void toOverlays(tab, "window.__kos && window.__kos.alive()");
    }, 1_000);
    note(`live for ${minutes} min`);
    await keepSession({ id, kos: origin, tabs: [], ...(conversation ? { conversation } : {}) });
    await badge();
    return { granted: true, until: session.info.until, ...(alone ? { auto: { site: alone } } : {}) };
  } finally {
    if (!session) {
      owner = undefined;
      void maybeReload();
    }
  }
}

/** The owner asked, in the side panel the chat is in or a window of the extension's own; no answer in the owner's wait is no. */
function askOwner(request: ConsentRequest, origin: string, panel?: Panel): Promise<Decided> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (a: Decided): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const asked = consents.get(request.id);
      consents.delete(request.id);
      if (asked?.window !== undefined) void chrome.windows.remove(asked.window).catch(() => undefined);
      asked?.panel?.port.postMessage({ type: "consent.done", id: request.id });
      resolve(a);
    };
    // A no exactly when the window says it will be.
    const timer = setTimeout(() => settle({ allowed: false, minutes: 0, why: "unanswered" }), Math.max(0, request.expiresAt - Date.now()));
    const entry: Asked = { request, origin, answer: settle, ...(panel ? { panel } : {}) };
    consents.set(request.id, entry);
    if (panel) {
      panel.port.postMessage({ type: "consent", request });
      return;
    }
    void chrome.windows
      .create({ url: chrome.runtime.getURL(`consent.html?id=${encodeURIComponent(request.id)}`), type: "popup", width: 440, height: 520, focused: true })
      .then((win) => {
        entry.window = win?.id;
      })
      .catch(() => settle({ allowed: false, minutes: 0, why: "unanswered" }));
  });
}

/** An expression in every frame's copy of the overlay on a tab, each given a moment and no more: a busy page holds nothing up. */
async function toOverlays(tab: number, expression: string, withinMs = 1_500, awaitPromise = false): Promise<void> {
  const worlds = overlays.get(tab);
  if (!worlds) return;
  await Promise.all([
    handFrames.toOverlays(tab, expression, withinMs),
    ...[...worlds].map((world) =>
      Promise.race([
        chrome.debugger.sendCommand({ tabId: tab }, "Runtime.evaluate", { expression, contextId: world, awaitPromise }).catch(() => worlds.delete(world)),
        new Promise((r) => setTimeout(r, withinMs)),
      ]),
    ),
  ]);
}

/** The most KOS's hands wait on the cursor: its quick glide is 45 to 135 ms, and a busy page holds nothing up past this. */
const GLIDE_WAIT_MS = 150;
/** Where KOS's cursor went last on each tab, to know whether it has anywhere to go. */
const pointed = new Map<number, { x: number; y: number }>();
/** Where it is or rests on each tab, for a new page there to put it back. */
const restsAt = new Map<number, { x: number; y: number }>();

/**
 * KOS's cursor to a point on a tab. A move or a press somewhere new is waited
 * on, briefly, so the owner sees it go before the act; anything else is sent
 * and not waited for. An element scrolled to only rests the cursor there.
 */
async function point(tab: number, at: { x: number; y: number }, how: PointHow): Promise<void> {
  const expression = `window.__kos && window.__kos.point(${at.x}, ${at.y}, ${JSON.stringify(how)})`;
  restsAt.set(tab, at);
  if (how === "rest") return void toOverlays(tab, expression, 300);
  const from = pointed.get(tab);
  pointed.set(tab, at);
  const goes = (how === "move" || how === "press") && (!from || Math.hypot(at.x - from.x, at.y - from.y) >= 1);
  if (!goes) return void toOverlays(tab, expression, 300);
  // The overlay starts the glide and says at once how long it takes (none on a tab no one sees): KOS's hands wait that
  // long on their own clock, from when it was sent, and never past the cap, however slow the tab is to answer.
  const sent = Date.now();
  const worlds = [...(overlays.get(tab) ?? [])];
  const glides = await Promise.race([
    Promise.all(
      worlds.map((world) =>
        chrome.debugger
          .sendCommand({ tabId: tab }, "Runtime.evaluate", { expression, contextId: world, returnByValue: true })
          .then(
            (r) => Number((r as { result?: { value?: unknown } } | undefined)?.result?.value) || 0,
            () => (overlays.get(tab)?.delete(world), 0),
          ),
      ),
    ),
    new Promise<number[]>((r) => setTimeout(() => r([GLIDE_WAIT_MS]), GLIDE_WAIT_MS)),
  ]);
  const left = Math.min(Math.max(0, ...glides), GLIDE_WAIT_MS) - (Date.now() - sent);
  if (left > 0) await new Promise((r) => setTimeout(r, left));
}

async function pointAtNode(tab: number, node: { backendNodeId: number }, how: PointHow): Promise<void> {
  const got = (await chrome.debugger.sendCommand({ tabId: tab }, "DOM.getContentQuads", node).catch(() => undefined)) as { quads?: unknown } | undefined;
  const at = middleOf(got?.quads);
  if (at) await point(tab, at, how);
}

async function end(reason: EndReason): Promise<void> {
  const ended = session;
  if (!ended) return;
  session = undefined;
  clearInterval(ticker);
  // Every tab let go of together: the overlay off each frame, then the debugger.
  await Promise.all(
    [...attached].map(async (tab) => {
      await toOverlays(tab, "window.__kos && window.__kos.remove()");
      await chrome.debugger.detach({ tabId: tab }).catch(() => undefined);
      handFrames.forget(tab);
    }),
  );
  attached.clear();
  for (const wake of [...commits]) wake();
  overlays.clear();
  pointed.clear();
  restsAt.clear();
  tabUrls.clear();
  loaders.clear();
  mainFrames.clear();
  worldsOf.clear();
  openRequests.clear();
  beside = undefined;
  clearTimeout(lineWait);
  lineWait = undefined;
  // A KOS off its line hears it in its next hello instead.
  const heard = owner !== undefined && links.get(owner)?.online === true;
  tell("session.ended", { session: ended.info.id, reason });
  await keepSession(heard || !owner ? undefined : { id: ended.info.id, kos: owner, tabs: [], ended: reason, ...(ended.info.conversation ? { conversation: ended.info.conversation } : {}) });
  owner = undefined;
  note(`ended: ${reason}${heard ? "" : "; its KOS hears it when back on its line"}`);
  if (ended.info.conversation) await sayEnded({ conversation: ended.info.conversation, reason, at: Date.now() });
  await badge();
  await maybeReload();
}

type ListedTab = { id: string; url: string; title: string; handed?: true; focus?: true; hidden?: true; held?: { loader: string; urls: string[] } };

/**
 * The session's tabs, as KOS is told of them. A tab a secret was filled
 * into says what it is held to (the document, and the addresses of
 * documents, a secret was in), so a KOS that comes to it in a new session
 * holds it too.
 */
async function listTabs(): Promise<ListedTab[]> {
  const s = session!;
  const out: ListedTab[] = [];
  for (const id of s.tabs) {
    const tab = await chrome.tabs.get(id).catch(() => undefined);
    if (!tab) continue;
    // The tab beside the side panel the owner gave by speaking from it, as one they handed.
    const taint = taints.get(id);
    const mark = {
      ...(handed.has(id) || id === beside ? { handed: true as const } : {}),
      ...(id === beside ? { focus: true as const } : {}),
      ...(taint ? { held: { loader: taint.loader, urls: taint.urls } } : {}),
    };
    // A tab on a hidden site, or on a page that is not on the web (a file, one of Chrome's own), is KOS's to know of, and nothing more.
    const url = tab.url ?? "";
    if (isHidden(url, settings.hiddenSites)) out.push({ id: String(id), url: "", title: "Hidden from KOS", hidden: true, ...mark });
    else if (url && !isWebPage(url)) out.push({ id: String(id), url: "", title: "Not a web page", ...mark });
    else out.push({ id: String(id), url, title: tab.title ?? "", ...mark });
  }
  return out;
}

/** A tab of KOS's own, in its window (made the first time, out of the owner's way), grouped as KOS. */
async function openTab(url: string): Promise<number> {
  const s = session;
  if (!s) throw new CallError("no_session", "no session is live in this Chrome");
  if (!isWebUrl(url)) throw new CallError("url", "only web pages (http and https) open in your Chrome");
  if (isHidden(url, settings.hiddenSites)) throw hiddenError(url);
  const kept = await chrome.storage.session.get("kosWindow");
  let windowId = typeof kept["kosWindow"] === "number" ? (kept["kosWindow"] as number) : undefined;
  if (windowId !== undefined && !(await chrome.windows.get(windowId).catch(() => undefined))) windowId = undefined;
  let tab: chrome.tabs.Tab;
  if (windowId === undefined) {
    const win = await chrome.windows.create({ url, focused: false, width: 1280, height: 900 });
    if (!win?.id || !win.tabs?.[0]) throw new CallError("internal", "Chrome made no window for KOS");
    windowId = win.id;
    tab = win.tabs[0];
    await chrome.storage.session.set({ kosWindow: windowId });
  } else {
    tab = await chrome.tabs.create({ windowId, url, active: true });
  }
  const groups = await chrome.tabGroups.query({ windowId, title: GROUP });
  const groupId = await chrome.tabs.group({ tabIds: tab.id!, ...(groups[0] ? { groupId: groups[0].id } : { createProperties: { windowId } }) });
  await chrome.tabGroups.update(groupId, { title: GROUP, color: "blue" });
  // The session may have ended while the tab was made: it is left to the owner, with no debugger on it.
  if (session !== s) throw new CallError("no_session", "the session ended while the tab opened");
  s.tabs.add(tab.id!);
  await attach(tab.id!);
  if (session !== s) {
    await chrome.debugger.detach({ tabId: tab.id! }).catch(() => undefined);
    attached.delete(tab.id!);
    throw new CallError("no_session", "the session ended while the tab opened");
  }
  return tab.id!;
}

/** Each tab's attach under way: a command sent meanwhile waits for it, so the tab's worlds are known before any command names one. */
const attaching = new Map<number, Promise<void>>();

/** A tab under KOS's hands: the debugger on it, and the overlay in a world of its own. */
function attach(tab: number): Promise<void> {
  let under = attaching.get(tab);
  if (under) return under;
  if (attached.has(tab)) return Promise.resolve();
  under = attachNow(tab).finally(() => attaching.delete(tab));
  attaching.set(tab, under);
  return under;
}

async function attachNow(tab: number): Promise<void> {
  await chrome.debugger.attach({ tabId: tab }, "1.3");
  attached.add(tab);
  if (lastSession && !lastSession.ended) await keepSession({ ...lastSession, tabs: [...attached] });
  const t = await chrome.tabs.get(tab).catch(() => undefined);
  if (t?.url) tabUrls.set(tab, t.url);
  const send = (method: string, params: Record<string, unknown> = {}): Promise<unknown> => chrome.debugger.sendCommand({ tabId: tab }, method, params);
  // First, so each world already in the tab (the page's, the overlay's) is heard of before KOS's first command.
  await send("Runtime.enable");
  await send("Page.enable");
  // Where the tab is, from its page: Chrome's word for it, asked before the debugger heard anything, may be from before a navigation.
  const tree = (await send("Page.getFrameTree").catch(() => undefined)) as { frameTree?: { frame?: { id?: unknown; url?: unknown; loaderId?: unknown } } } | undefined;
  const main = tree?.frameTree?.frame;
  if (typeof main?.url === "string") tabUrls.set(tab, main.url);
  if (typeof main?.id === "string") mainFrames.set(tab, main.id);
  // The document a secret may be in, as the debugger finds it: a tab attached again is held to what was filled before.
  if (typeof main?.loaderId === "string") loaders.set(tab, main.loaderId);
  await send("Runtime.addBinding", { name: BINDING, executionContextName: WORLD });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: OVERLAY_SOURCE, worldName: WORLD, runImmediately: true });
  // Frames from other sites run in processes of their own: each is attached too, so the owner's hand in one is seen.
  // Best effort: a Chrome that will not attach them still has its tab worked in, with its frames' hands unseen.
  await handFrames.watch({ tabId: tab }).catch((err: unknown) => note(`frames of other sites not watched: ${err instanceof Error ? err.message : String(err)}`));
}

const record = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

async function relay(params: Record<string, unknown>, origin: string): Promise<Record<string, unknown>> {
  const s = live(params, origin);
  return relayOne(s, tabOf(s, params), str(params["method"]), record(params["params"]), frameNamed(params));
}

/** The frame of another process a call names, by its frame id (its target's), to be sent through that frame's own session; none for the tab's. */
function frameNamed(params: Record<string, unknown>): string | undefined {
  const frame = params["frame"];
  if (frame === undefined) return undefined;
  if (typeof frame !== "string" || !frame || frame.length > 512) throw new CallError("bad_request", "a frame is named by its id");
  return frame;
}

/**
 * Several commands to one tab in one round trip, each checked as one alone
 * would be: in order, stopping at the first that fails (a press after a move
 * that failed would land somewhere else), or side by side when `parallel`
 * says they do not depend on one another. Each answer is `{ result }` or
 * `{ error }`; those not sent after a failure are left out. The owner having
 * taken the tab over, the session ending or the tab taken back, at any point
 * in it, refuses the whole batch: nothing after is sent.
 */
async function relayAll(params: Record<string, unknown>, origin: string): Promise<Record<string, unknown>> {
  const s = live(params, origin);
  const tab = tabOf(s, params);
  const frame = frameNamed(params);
  const calls = (Array.isArray(params["calls"]) ? params["calls"] : []).map(record);
  if (calls.length === 0 || calls.length > BATCH_MAX) throw new CallError("bad_request", `a batch is 1 to ${BATCH_MAX} commands`);
  // KOS's hands act one after another, each after its cursor: never side by side.
  if (params["parallel"] === true && calls.some((c) => isInput(str(c["method"])))) throw new CallError("bad_request", "a batch with input in it runs in order");
  const one = async (call: Record<string, unknown>): Promise<Record<string, unknown>> => {
    try {
      return { result: await relayOne(s, tab, str(call["method"]), record(call["params"]), frame) };
    } catch (err) {
      // The owner taking over is the whole batch's answer, as it is a lone command's: KOS waits for them. So is the session or the tab gone.
      if (err instanceof CallError && WHOLE_BATCH.has(err.code)) throw err;
      return { error: { code: err instanceof CallError ? err.code : "cdp", message: err instanceof Error ? err.message : String(err) } };
    }
  };
  if (params["parallel"] === true) return { results: await Promise.all(calls.map(one)) };
  const results: Record<string, unknown>[] = [];
  for (const call of calls) {
    const answer = await one(call);
    results.push(answer);
    if ("error" in answer) break;
  }
  return { results };
}

function pausedError(): CallError {
  return new CallError("paused", "the owner has taken over this tab; wait for them to hand it back");
}

/** Commands to one session of a tab's debugger, from the extension itself. */
const sendTo =
  (target: chrome.debugger.Debuggee & { sessionId?: string }): Send =>
  async (method, params = {}) =>
    ((await chrome.debugger.sendCommand(target, method, params)) as Record<string, unknown> | undefined) ?? {};

/** A tab as the extension's own checks reach it: its debugger, and each frame of another process KOS's hands may reach, through that frame's own session. */
function reachOf(tab: number): Reach {
  return {
    send: sendTo({ tabId: tab }),
    frame: (id) => {
      const sessionId = handFrames.sessionOf(tab, id);
      return sessionId ? sendTo({ tabId: tab, sessionId }) : undefined;
    },
  };
}

/** What a tab a secret was filled into is held to now, by its document and address as the debugger last heard them. */
function heldOn(tab: number): { nodes: { frame: string; node: number }[] } | undefined {
  return heldNow(taints.get(tab), loaders.get(tab) ?? "", tabUrls.get(tab) ?? "");
}

/** Refused on a tab holding a secret: a script step, a copy, a drag, or typing into a filled field. */
async function refuseHeld(tab: number, method: string, args: Record<string, unknown>): Promise<void> {
  const held = heldOn(tab);
  if (!held) return;
  const why = heldRefusal(method, args);
  if (why) throw new CallError("tainted", `${why} is refused: ${FILLED_PAGE}`);
  if (!typesText(method, args) && !editsField(method, args)) return;
  // On a page a secret was in come back to, no field is known: an editing command anywhere is taken as aimed at one.
  if (!held.nodes.length ? editsField(method, args) : await focusedOn(reachOf(tab), held.nodes)) throw new CallError("tainted", `typing or editing in a filled field is refused: ${FILLED_PAGE}`);
}

/**
 * A saved secret into one field of a tab of the session (secret.fill; see
 * secret.ts): checked again here, put in, marked. The answer says it was
 * filled and nothing more; the value is dropped from the call's parameters
 * once read and never logged, and a refusal's words never hold it.
 */
async function secretFill(params: Record<string, unknown>, origin: string): Promise<Record<string, unknown>> {
  let put: SecretPut | undefined;
  try {
    put = readPut(params);
    delete params["value"];
    const s = live(params, origin);
    const tab = tabOf(s, params);
    if (s.paused) throw pausedError();
    await refuseHidden(tab);
    await attach(tab);
    stillIn(s, tab);
    if (s.paused) throw pausedError();
    await pointAtField(tab, put);
    const doc = put.doc;
    await fillField(reachOf(tab), put, (field) => {
      taints.set(tab, marked(taints.get(tab), doc, tabUrls.get(tab) ?? "", field));
      void saveTaints();
    });
    note("secret.fill: filled");
    return { filled: true };
  } catch (err) {
    note(`secret.fill: refused (${err instanceof CallError ? err.code : "error"})`);
    throw err instanceof CallError ? err : new CallError("internal", "the secret could not be filled");
  } finally {
    if (put) put.value = "";
  }
}

/** A picture of a tab of the session with each of its frames masked by the patterns KOS sent for its origin (see secret.ts maskedShot). */
async function secretPicture(params: Record<string, unknown>, origin: string): Promise<Record<string, unknown>> {
  const s = live(params, origin);
  const tab = tabOf(s, params);
  const masks = readMasks(params["masks"]);
  await refuseHidden(tab);
  await attach(tab);
  stillIn(s, tab);
  const shot = await picture(tab, params, masks);
  // As a lone picture is: a page that went to a hidden site meanwhile gives KOS nothing of it.
  await refuseHidden(tab);
  return shot;
}

/** KOS's cursor to a field a secret goes into: in a frame of another process, where that frame is drawn in the tab. */
async function pointAtField(tab: number, put: SecretPut): Promise<void> {
  const sessionId = handFrames.sessionOf(tab, put.frame);
  if (!sessionId) return pointAtNode(tab, { backendNodeId: put.node }, "move");
  const got = (await chrome.debugger.sendCommand({ tabId: tab, sessionId }, "DOM.getContentQuads", { backendNodeId: put.node }).catch(() => undefined)) as { quads?: unknown } | undefined;
  const at = middleOf(got?.quads);
  const inTab = at ? await handFrames.inTab(tab, sessionId, put.frame, at, mainFrames.get(tab)) : undefined;
  if (inTab) await point(tab, inTab, "move");
}

/**
 * One command from KOS to a tab, or to a frame of it in a process of its
 * own (`frame`, by its id): only a reading or a script of KOS's hands goes
 * to a frame, through that frame's own session, and only one whose Runtime
 * domain is on (handframes.ts), never a challenge's.
 */
/**
 * The web origins of a tab's frames, those in processes of their own among
 * them, read here (frames.ts): KOS names by them the patterns a picture of
 * the tab is masked by (secret.picture). The page's tree stays here.
 */
async function tabOrigins(params: Record<string, unknown>, origin: string): Promise<Record<string, unknown>> {
  const s = live(params, origin);
  const tab = tabOf(s, params);
  await refuseHidden(tab);
  await attach(tab);
  stillIn(s, tab);
  const map = await tabMap(reachOf(tab)).catch(() => undefined);
  if (!map) throw new CallError("cdp", "the tab's frames could not be read");
  return { origins: [...new Set([...map.frames.values()].map((f) => f.origin).filter((o) => /^https?:\/\//.test(o)))] };
}

async function relayOne(s: Session, tab: number, method: string, args: Record<string, unknown>, frame?: string): Promise<Record<string, unknown>> {
  checkCommand(method, args);
  if (frame !== undefined) checkFrameCommand(method);
  stillIn(s, tab);
  // Not a look, a click or a word on a hidden site, and no way there.
  await refuseHidden(tab);
  stillIn(s, tab);
  if (method === "Page.navigate" && isHidden(str(args["url"]), settings.hiddenSites)) throw hiddenError(str(args["url"]));
  if (s.paused && changesPage(method)) throw pausedError();
  await attach(tab);
  // Let go of meanwhile: not held on to for a session that has gone.
  if (session !== s || !s.tabs.has(tab)) {
    if (!session?.tabs.has(tab) && attached.delete(tab)) await chrome.debugger.detach({ tabId: tab }).catch(() => undefined);
    stillIn(s, tab);
  }
  const sessionId = frame === undefined ? undefined : handFrames.sessionOf(tab, frame);
  if (frame !== undefined && !sessionId) throw new CallError("cdp", "that frame is not one KOS reaches: it is gone, or it is a challenge's");
  await reachable(tab, args, sessionId);
  await refuseHeld(tab, method, args);
  // KOS's cursor where its hands are about to act, on its way before they do: input is the tab's, and aimed in its terms.
  const aim = frame === undefined ? aimOf(method, args) : undefined;
  if (aim && "at" in aim) await point(tab, aim.at, aim.how);
  else if (aim && "typing" in aim) void toOverlays(tab, "window.__kos && window.__kos.typing()", 300);
  if (changesPage(method)) {
    // A step back or forward to a hidden site is refused by where it goes; asked of the tab first, so nothing is awaited after the checks below.
    if (method === "Page.navigateToHistoryEntry") {
      await refuseHiddenEntry(tab, args["entryId"]).catch((err: unknown) => {
        throw err instanceof CallError ? err : new CallError("cdp", err instanceof Error ? err.message : String(err));
      });
    }
    // Anything could have happened while the tab was taken up and the cursor went: the page gone to a hidden site, the
    // owner's hand on it. Checked again, and nothing awaited between this and sending.
    await refuseHidden(tab);
    stillIn(s, tab);
    if (s.paused) throw pausedError();
  }
  if (isInput(method)) s.dispatching(method, args, Date.now());
  let answer: Record<string, unknown>;
  try {
    if (method === "Page.captureScreenshot") answer = await picture(tab, args);
    else answer = ((await chrome.debugger.sendCommand({ tabId: tab, ...(sessionId ? { sessionId } : {}) }, method, args)) as Record<string, unknown> | undefined) ?? {};
    // A navigation answers before its page is in; the next command waits for it, so it is checked against where the tab went.
    if (method === "Page.navigate" && typeof answer["loaderId"] === "string" && !answer["errorText"]) await committed(tab, answer["loaderId"]);
  } catch (err) {
    if (err instanceof CallError) throw err;
    // Cut off by the session ending or the tab taken back, which is the answer, not the debugger's words for it.
    stillIn(s, tab);
    // Nor a word of a page cut off by going to a hidden site.
    await refuseHidden(tab);
    throw new CallError("cdp", err instanceof Error ? err.message : String(err));
  }
  // Checked again once answered: a page that went to a hidden site while the command ran (a click, a reload, a redirect) gives KOS nothing of it.
  await refuseHidden(tab);
  // An element focused to type in, or scrolled to: the cursor to its middle, now that it is in view, before KOS's next command.
  if (aim && "node" in aim) await pointAtNode(tab, aim.node, aim.how);
  if (method === "Page.getNavigationHistory") return withoutHidden(answer);
  // What the browser says a field holds stays here: its own shadow roots, and the tree's value of a field a secret is in.
  return hiddenValues(method, withoutFieldText(method, answer), heldOn(tab), frame ?? "");
}

/**
 * Refused when the tab is on a hidden site, or on its way to one: by the
 * address the debugger last heard while it is on the tab, and by Chrome's,
 * which is all there is for a tab let go of (it may have gone anywhere
 * since).
 */
async function refuseHidden(tab: number): Promise<void> {
  const t = await chrome.tabs.get(tab).catch(() => undefined);
  const urls = [attached.has(tab) ? tabUrls.get(tab) : undefined, t?.url, t?.pendingUrl];
  for (const url of urls) {
    if (url && isHidden(url, settings.hiddenSites)) throw hiddenError(url);
  }
  // Nor a page of Chrome's own or an extension's that a page went to by itself: KOS drives only the web.
  for (const url of urls) {
    if (url && !isWebPage(url)) throw notWebError();
  }
}

function notWebError(): CallError {
  return new CallError("url", "the tab is on a page that is not a web address (one of Chrome's own or an extension's); KOS drives only web pages, so the owner takes it from here");
}

/** Refused when the history entry a command would go back or forward to is on a hidden site, or is not a web page. */
async function refuseHiddenEntry(tab: number, entryId: unknown): Promise<void> {
  const history = (await chrome.debugger.sendCommand({ tabId: tab }, "Page.getNavigationHistory", {})) as { entries?: { id?: unknown; url?: unknown }[] } | undefined;
  const url = history?.entries?.find((e) => e.id === entryId)?.url;
  if (typeof url !== "string" || !isWebPage(url)) throw notWebError();
  if (isHidden(url, settings.hiddenSites)) throw hiddenError(url);
}

/** A tab's history with the entries on hidden sites nameless: there, and nothing more. */
function withoutHidden(history: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(history["entries"])) return history;
  const entries = (history["entries"] as Record<string, unknown>[]).map((e) => (typeof e["url"] === "string" && isHidden(e["url"], settings.hiddenSites) ? { ...e, url: "", userTypedURL: "", title: "Hidden from KOS" } : e));
  return { ...history, entries };
}

/** How long a navigation's answer waits for its page to come in, at most. */
const COMMIT_WAIT_MS = 5_000;

/** Until the tab's main frame holds the document `loader`, the tab is let go of, or the most worth waiting has gone. */
function committed(tab: number, loader: string): Promise<void> {
  const there = (): boolean => loaders.get(tab) === loader || !attached.has(tab);
  if (there()) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      commits.delete(check);
      resolve();
    };
    const check = (): void => {
      if (there()) done();
    };
    const timer = setTimeout(done, COMMIT_WAIT_MS);
    commits.add(check);
  });
}

/** How long a command naming a world Chrome has not said it made waits to hear of it: one KOS just made may be told a moment after. */
const WORLD_WAIT_MS = 200;

/** Refused unless each world a command names is the page's or KOS's hands' in the tab or the frame session it goes to, one just made waited for a moment. */
async function reachable(tab: number, args: Record<string, unknown>, frameSession?: string): Promise<void> {
  const of = (): Worlds => (frameSession !== undefined ? handFrames.worldsOf(frameSession) : worldsOf.get(tab)) ?? new Worlds();
  if (!of().heard(args)) {
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        worldsMade.delete(check);
        resolve();
      };
      const check = (): void => {
        if (of().heard(args) || !attached.has(tab)) done();
      };
      const timer = setTimeout(done, WORLD_WAIT_MS);
      worldsMade.add(check);
    });
  }
  of().check(args);
}

/** How long a tab on screen may take to hand over the frame Chrome drew. */
const FRAME_WAIT_MS = 400;
/** Frames being taken, by tab: a second picture asked for meanwhile is the same one. */
const framing = new Map<number, Promise<string | undefined>>();

/**
 * A picture of a tab, without touching what the owner sees. Asked for with a
 * clip and a scale, Chrome draws the page again at that size, which on a tab
 * the owner is looking at flashes on every look. So a tab on screen is taken
 * from the frame Chrome already drew, made small as it is taken; one that is
 * not on screen draws no frames, and is captured as it is and made smaller
 * here. `maxEdge` is the relay's own, not the protocol's: the picture's
 * longer side.
 */
/** Pictures being taken, by tab: the cursor is whole again once the last is in. */
const picturing = new Map<number, number>();

/** Masked pictures under way, by tab, in turn: each measures the page on both sides of its picture. */
const masking = new Map<number, Promise<unknown>>();

/**
 * A picture of the tab with KOS's cursor down to its arrow, whose halo and
 * tag would cover what KOS reads. A tab a secret was filled into, or one
 * KOS sent `masks` for, is taken afresh between two measurings of the page
 * and painted over here (secret.ts maskedShot), never from a frame Chrome
 * drew before the first.
 */
async function picture(tab: number, args: Record<string, unknown>, masks?: Record<string, string[]>): Promise<Record<string, unknown>> {
  picturing.set(tab, (picturing.get(tab) ?? 0) + 1);
  await toOverlays(tab, "window.__kos && window.__kos.capturing(true)", 100, true);
  try {
    const held = heldOn(tab);
    if (!held && !masks) return await pictureOf(tab, args);
    const next = (masking.get(tab) ?? Promise.resolve()).then(() => maskedShot(reachOf(tab), held !== undefined, masks, () => rawShot(tab), (shot, boxesIn) => painted(shot, boxesIn, args)));
    masking.set(tab, next.catch(() => undefined));
    return { data: await next };
  } finally {
    const left = (picturing.get(tab) ?? 1) - 1;
    if (left > 0) picturing.set(tab, left);
    else {
      picturing.delete(tab);
      void toOverlays(tab, "window.__kos && window.__kos.capturing(false)", 300);
    }
  }
}

async function pictureOf(tab: number, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const format = args["format"] === "png" ? "png" : "jpeg";
  const quality = typeof args["quality"] === "number" ? Math.min(100, Math.max(1, Math.round(args["quality"]))) : 80;
  const edge = typeof args["maxEdge"] === "number" && args["maxEdge"] > 0 ? Math.round(args["maxEdge"]) : 0;
  if (format === "jpeg" && edge && (await onScreen(tab))) {
    const data = await frameOf(tab, quality, edge);
    if (data) return { data };
  }
  const send = (method: string, params: Record<string, unknown>): Promise<unknown> => chrome.debugger.sendCommand({ tabId: tab }, method, params);
  const shot = (await send("Page.captureScreenshot", { format, ...(format === "jpeg" ? { quality } : {}), optimizeForSpeed: true })) as { data?: string };
  if (!shot.data || !edge) return shot;
  const image = await createImageBitmap(new Blob([fromBase64(shot.data)], { type: `image/${format}` }));
  const scale = edge / Math.max(image.width, image.height);
  if (scale >= 1) {
    image.close();
    return shot;
  }
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
  canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
  image.close();
  const blob = await canvas.convertToBlob({ type: `image/${format}`, quality: quality / 100 });
  return { data: toBase64(new Uint8Array(await blob.arrayBuffer())) };
}

/** The tab as it is drawn now, without loss, for a picture to be painted over. */
async function rawShot(tab: number): Promise<Shot> {
  const shot = (await chrome.debugger.sendCommand({ tabId: tab }, "Page.captureScreenshot", { format: "png" })) as { data?: string } | undefined;
  return { data: shot?.data ?? "", format: "png" };
}

/** A picture with each box `boxesIn` gives for its size painted black, made as small and in the format KOS asked for. */
async function painted(shot: Shot, boxesIn: (image: { width: number; height: number }) => number[], args: Record<string, unknown>): Promise<string> {
  const format = args["format"] === "png" ? "png" : "jpeg";
  const quality = typeof args["quality"] === "number" ? Math.min(100, Math.max(1, Math.round(args["quality"]))) : 80;
  const edge = typeof args["maxEdge"] === "number" && args["maxEdge"] > 0 ? Math.round(args["maxEdge"]) : 0;
  const image = await createImageBitmap(new Blob([fromBase64(shot.data)], { type: `image/${shot.format}` }));
  const scale = edge ? Math.min(1, edge / Math.max(image.width, image.height)) : 1;
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
  const g = canvas.getContext("2d")!;
  g.drawImage(image, 0, 0, canvas.width, canvas.height);
  image.close();
  const boxes = boxesIn({ width: canvas.width, height: canvas.height });
  g.fillStyle = "#000";
  for (let i = 0; i + 3 < boxes.length; i += 4) g.fillRect(boxes[i]!, boxes[i + 1]!, boxes[i + 2]!, boxes[i + 3]!);
  const blob = await canvas.convertToBlob({ type: `image/${format}`, quality: quality / 100 });
  return toBase64(new Uint8Array(await blob.arrayBuffer()));
}

/** Whether the tab is drawn: in front in its window, and its window not hidden or folded away. */
async function onScreen(tab: number): Promise<boolean> {
  const seen = (await chrome.debugger.sendCommand({ tabId: tab }, "Runtime.evaluate", { expression: "document.visibilityState", returnByValue: true }).catch(() => undefined)) as
    | { result?: { value?: unknown } }
    | undefined;
  return seen?.result?.value === "visible";
}

/** The frame Chrome draws next of the tab, at most `edge` on its longer side, from a cast started and stopped for it. */
function frameOf(tab: number, quality: number, edge: number): Promise<string | undefined> {
  const taking = framing.get(tab);
  if (taking) return taking;
  const send = (method: string, params: Record<string, unknown> = {}): Promise<unknown> => chrome.debugger.sendCommand({ tabId: tab }, method, params);
  const taken = new Promise<string | undefined>((resolve) => {
    const done = (data: string | undefined): void => {
      clearTimeout(timer);
      chrome.debugger.onEvent.removeListener(heard);
      void send("Page.stopScreencast").catch(() => undefined);
      resolve(data);
    };
    const heard = (source: chrome.debugger.Debuggee, method: string, params?: object): void => {
      if (source.tabId !== tab || method !== "Page.screencastFrame") return;
      const frame = (params ?? {}) as { data?: string; sessionId?: number };
      void send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => undefined);
      done(frame.data || undefined);
    };
    const timer = setTimeout(() => done(undefined), FRAME_WAIT_MS);
    chrome.debugger.onEvent.addListener(heard);
    send("Page.startScreencast", { format: "jpeg", quality, maxWidth: edge, maxHeight: edge, everyNthFrame: 1 }).catch(() => done(undefined));
  }).finally(() => framing.delete(tab));
  framing.set(tab, taken);
  return taken;
}

/** Whether a tab's event would tell KOS of a hidden site: the tab is on one, or the event is a way to one. */
function fromHidden(tab: number, params: Record<string, unknown>): boolean {
  const frame = params["frame"] as { url?: unknown } | undefined;
  const request = params["request"] as { url?: unknown } | undefined;
  // A dialog says the address of the frame that opened it as `url`.
  return [tabUrls.get(tab), frame?.url, request?.url, params["documentURL"], params["url"]].some((u) => typeof u === "string" && isHidden(u, settings.hiddenSites));
}

// The owner's hands.

function overlayState(): OverlayState {
  const face = faceOf(owner);
  return {
    task: session?.info.task ?? "",
    paused: session?.paused ?? false,
    until: session?.info.until ?? 0,
    face: { fill: face.fill, ink: face.ink, eyes: face.eyes, body: smoothPath(outline(face.shape)) },
    theme: themeOf(settings.theme, sentTheme),
    bar: settings.fullBar,
    ...barPlace,
  };
}

async function paint(): Promise<void> {
  const expression = `window.__kos && window.__kos.set(${JSON.stringify(overlayState())})`;
  await Promise.all([...overlays.keys()].map((tab) => toOverlays(tab, expression)));
}

async function pause(): Promise<void> {
  if (!session || session.paused) return;
  session.pause();
  tell("session.paused", { session: session.info.id, reason: "owner" });
  note("paused: the owner took over");
  await Promise.all([paint(), badge()]);
}

async function resume(): Promise<void> {
  if (!session?.paused) return;
  session.resume(Date.now());
  tell("session.resumed", { session: session.info.id });
  note("resumed");
  await Promise.all([paint(), badge()]);
}

/**
 * What an overlay said: in the tab's own session, or in a frame's of its own
 * (`frame`), where it draws nothing and only reports the owner's hand.
 */
async function fromOverlay(tab: number, world: number, payload: string, frame?: string): Promise<void> {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return;
  }
  if (frame !== undefined && message["kind"] !== "input") {
    if (message["kind"] === "hello") {
      handFrames.hello(frame, world);
      await chrome.debugger.sendCommand({ tabId: tab, sessionId: frame }, "Runtime.evaluate", { expression: "window.__kos && window.__kos.alive()", contextId: world }).catch(() => undefined);
    }
    return;
  }
  switch (message["kind"]) {
    case "hello": {
      overlays.set(tab, (overlays.get(tab) ?? new Set()).add(world));
      await chrome.debugger.sendCommand({ tabId: tab }, "Runtime.evaluate", { expression: `window.__kos && window.__kos.set(${JSON.stringify(overlayState())})`, contextId: world }).catch(() => undefined);
      // A new page of a tab KOS has pointed on: its cursor where it was, not back in the middle.
      const at = restsAt.get(tab);
      if (at) {
        await chrome.debugger.sendCommand({ tabId: tab }, "Runtime.evaluate", { expression: `window.__kos && window.__kos.point(${at.x}, ${at.y}, "place")`, contextId: world }).catch(() => undefined);
      }
      return;
    }
    case "input": {
      // The owner may scroll a KOS tab freely, if they said so.
      if (settings.takeover === "clicksAndKeys" && message["type"] === "wheel") return;
      if (!session || session.paused) return;
      const now = Date.now();
      const input = await inTab(tab, world, frame, message as unknown as PageInput);
      // A click or a key takes over at once; a scroll just after they allowed it or handed it back is their hand still letting go.
      if (session && !session.paused && session.takesOver(input, now)) await pause();
      return;
    }
    case "place": {
      const x = Number(message["x"]);
      const y = Number(message["y"]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      barPlace = { ...barPlace, at: { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) } };
      await chrome.storage.session.set({ bar: barPlace });
      return paint();
    }
    case "fold":
      barPlace = { ...barPlace, folded: message["folded"] === true };
      await chrome.storage.session.set({ bar: barPlace });
      return paint();
    case "take":
      return pause();
    case "handback":
      return resume();
    case "stop":
      return stopByOwner();
    default:
      return;
  }
}

/**
 * Input an overlay reported, where it landed in the tab: a frame's report is
 * in that frame's coordinates, and KOS aims its own in the tab's. One whose
 * frame cannot be placed is left with no point, and is matched against KOS's
 * own input by kind and time alone (session.ts).
 */
async function inTab(tab: number, world: number, frame: string | undefined, input: PageInput): Promise<PageInput> {
  if (typeof input.x !== "number" || typeof input.y !== "number") return input;
  const from = frame !== undefined ? handFrames.frameOf(frame, world) : worldsOf.get(tab)?.frameOf(world);
  const at = await handFrames.inTab(tab, frame, from, { x: input.x, y: input.y }, mainFrames.get(tab));
  return at ? { ...input, ...at } : { type: input.type };
}

/** An event about a tab's frames in processes of their own, or on one's session: the overlay's word there is heard as any other's. */
async function fromFrames(tab: number, frame: string | undefined, method: string, params: Record<string, unknown>): Promise<void> {
  const heard = await handFrames.heard(tab, frame, method, params);
  if (method === "Runtime.executionContextCreated") for (const wake of [...worldsMade]) wake();
  // Where a frame of another process went is KOS's hands' to know, for their worlds in it: as a frame of the tab's own process is told.
  if (method === "Page.frameNavigated" && frame !== undefined && handFrames.has(frame) && session?.tabs.has(tab) && !fromHidden(tab, params)) {
    tell("cdp.event", { session: session.info.id, tab: String(tab), method, params });
  }
  if (heard && frame !== undefined && session?.tabs.has(tab)) await fromOverlay(tab, heard.world, heard.payload, frame);
}

/**
 * The owner's Stop on the bar, in the popup or in the side panel: the
 * chat the session is for is told to stop its turn too, then the session
 * ends as theirs to end.
 */
async function stopByOwner(): Promise<void> {
  const chat = session?.info.conversation;
  if (chat) tell("chat.stop", { chat });
  await end("owner");
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tab = source.tabId;
  if (tab === undefined || !attached.has(tab)) return;
  const p = (params ?? {}) as Record<string, unknown>;
  // A frame's own session, or a frame attached or gone: the extension's alone, never passed on to KOS.
  if (source.sessionId !== undefined || method.startsWith("Target.")) return void fromFrames(tab, source.sessionId, method, p);
  if (heardWorld(tab, method, p)) return;
  if (!session?.tabs.has(tab)) return;
  if (method === "Runtime.bindingCalled") {
    const world = Number(p["executionContextId"]);
    if (p["name"] === BINDING && worldsOf.get(tab)?.isOverlay(world)) void fromOverlay(tab, world, str(p["payload"]));
    return;
  }
  const frame = p["frame"] as { id?: unknown; url?: unknown; parentId?: unknown; loaderId?: unknown } | undefined;
  if (method === "Page.frameNavigated" && frame && !frame.parentId && typeof frame.url === "string") {
    tabUrls.set(tab, frame.url);
    loaders.set(tab, String(frame.loaderId ?? ""));
    if (typeof frame.id === "string") mainFrames.set(tab, frame.id);
    for (const wake of [...commits]) wake();
  }
  // A route the page changed to itself (pushState): the main frame's moves the tab's address, and is passed on; a frame's within it is not.
  if (method === "Page.navigatedWithinDocument") {
    if (p["frameId"] !== mainFrames.get(tab)) return;
    if (typeof p["url"] === "string") {
      tabUrls.set(tab, p["url"]);
      const moved = movedWithin(taints.get(tab), loaders.get(tab) ?? "", p["url"]);
      if (moved) {
        taints.set(tab, moved);
        void saveTaints();
      }
    }
  }
  if (fromHidden(tab, p)) return;
  const open = openRequests.get(tab) ?? new Set<string>();
  openRequests.set(tab, open);
  const passed = forwarded(method, p, open);
  if (passed) tell("cdp.event", { session: session.info.id, tab: String(tab), method, params: passed });
});

/** A world made in a tab or gone from it, kept; false for any other event. */
function heardWorld(tab: number, method: string, p: Record<string, unknown>): boolean {
  const known = (): Worlds => {
    const tabWorlds = worldsOf.get(tab) ?? new Worlds();
    worldsOf.set(tab, tabWorlds);
    return tabWorlds;
  };
  if (method === "Runtime.executionContextCreated") {
    known().made(record(p["context"]));
    for (const wake of [...worldsMade]) wake();
    return true;
  }
  if (method === "Runtime.executionContextDestroyed") {
    known().destroyed(Number(p["executionContextId"]), typeof p["executionContextUniqueId"] === "string" ? p["executionContextUniqueId"] : undefined);
    return true;
  }
  if (method === "Runtime.executionContextsCleared") {
    known().cleared();
    return true;
  }
  return false;
}

chrome.debugger.onDetach.addListener((source, reason) => {
  const tab = source.tabId;
  if (tab === undefined) return;
  attached.delete(tab);
  overlays.delete(tab);
  handFrames.forget(tab);
  pointed.delete(tab);
  restsAt.delete(tab);
  tabUrls.delete(tab);
  loaders.delete(tab);
  mainFrames.delete(tab);
  worldsOf.delete(tab);
  openRequests.delete(tab);
  for (const wake of [...commits]) wake();
  // Closing Chrome's debugging bar is the owner saying stop.
  if (reason === "canceled_by_user") void end("detached");
});

chrome.tabs.onUpdated.addListener((tab, change, info) => {
  if (change.url && attached.has(tab)) tabUrls.set(tab, change.url);
  // What was selected on a page is not selected on the next one.
  if ((change.status === "loading" || change.url) && selections.delete(tab) && info.active) void tellSelection(info.windowId, tab);
});

/** A tab gone from Chrome, closed or replaced by another (a page Chrome loaded ahead swapped in). */
function gone(tab: number): void {
  if (taints.delete(tab)) void saveTaints();
  masking.delete(tab);
  tabUrls.delete(tab);
  loaders.delete(tab);
  mainFrames.delete(tab);
  worldsOf.delete(tab);
  openRequests.delete(tab);
  selections.delete(tab);
  if (tab === beside) beside = undefined;
  if (handed.delete(tab)) void saveHanded();
  if (!session?.tabs.has(tab)) return;
  session.tabs.delete(tab);
  tell("tab.closed", { session: session.info.id, tab: String(tab) });
}

chrome.tabs.onRemoved.addListener(gone);
chrome.tabs.onReplaced.addListener((_added, removed) => gone(removed));

// The popup and the consent window.

function popupState(): PopupState {
  const { askFirst: _perKos, ...shown } = settings;
  return {
    kos: pairings.map((p) => {
      // A line not dialled yet is about to be, unless the owner held it.
      const line = linkStates.get(p.device) ?? { state: held.has(p.device) ? ("offline" as const) : ("connecting" as const) };
      return {
        id: p.device,
        url: p.url,
        host: hostOf(p),
        name: p.name,
        link: line.state,
        ...(line.detail ? { detail: line.detail } : {}),
        askFirst: asksFirst(settings, p.device),
        held: held.has(p.device),
        ...(p.face ? { face: p.face } : {}),
      };
    }),
    session: session
      ? {
          task: session.info.task,
          requester: session.info.requester,
          until: session.info.until,
          paused: session.paused,
          ...(kosName(owner) ? { kos: kosName(owner)! } : {}),
          ...(beside !== undefined ? { beside } : {}),
          ...(session.info.conversation ? { conversation: session.info.conversation } : {}),
          face: faceOf(owner),
        }
      : null,
    handed: [...handed],
    settings: shown,
    ...(sentTheme ? { dashboardTheme: sentTheme } : {}),
  };
}

/**
 * Pair with a KOS, by its address and code as the popup asks, or by the link the dashboard gives: another line beside the
 * rest, or in place of the one to the same KOS, which keeps its rule about asking first.
 */
async function pair({ url, code }: Pairing, name: string): Promise<void> {
  const keys = await newKeys();
  // Sent as plain text, a request a page may make without asking first; KOS reads it as JSON, and lets any origin read its answer.
  const res = await fetch(`${url}/api/devices/pair`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ code, name, platform: "chrome", publicKey: await publicKey(keys) }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof body["error"] === "string" ? body["error"] : `KOS answered ${res.status}`);
  if (body["protocol"] !== PROTOCOL || typeof body["device"] !== "string" || typeof body["hostKey"] !== "string") throw new Error("KOS answered in a way this extension does not understand; update it");
  const next: Paired = { url, device: body["device"], hostKey: body["hostKey"], name };
  const replaced = replacedBy(next, pairings);
  const keep = replaced[0] ? asksFirst(settings, replaced[0].device) : true;
  // That KOS made a new device for this pairing; the old one goes from its list, and its key with it, before the new key is kept:
  // a KOS that gave the same id again must not lose the key just kept for it.
  for (const old of replaced) {
    await forgetLine(old.device, old.device !== next.device);
    if (old.device !== next.device) await forgetKeys(old.device, false);
  }
  await keepKeys(next.device, keys);
  pairings = adding(next, pairings);
  settings.askFirst[next.device] = keep;
  await Promise.all([savePairings(), saveSettings(), saveHeld()]);
  note(`paired with ${hostOf(next)}${replaced.length ? ", in place of the old pairing" : ""}`);
  await connect(next);
}

/** A KOS's line ends for good; with `tell`, that KOS hears this Chrome is unpaired and forgets it. */
async function forgetLine(id: string, say: boolean): Promise<void> {
  if (owner === id) await end("owner");
  const link = links.get(id);
  if (say) link?.unpair();
  else link?.stop();
  links.delete(id);
  linkStates.delete(id);
  held.delete(id);
  delete settings.askFirst[id];
}

async function unpair(id: string): Promise<void> {
  const p = pairingOf(id);
  await forgetLine(id, true);
  pairings = removing(id, pairings);
  await Promise.all([savePairings(), saveSettings(), saveHeld()]);
  // Its key goes with it; the one key an older version shared goes once no pairing is left to use it.
  await forgetKeys(id, !pairings.length);
  note(`unpaired from ${p ? hostOf(p) : id}`);
  await badge();
}

/** That KOS sees this Chrome offline until Connect; a session it holds ends with its line. */
async function disconnect(id: string): Promise<void> {
  held.add(id);
  await saveHeld();
  links.get(id)?.stop();
  linkStates.set(id, { state: "offline" });
  note(`${hostOf(pairingOf(id) ?? { url: id })}: disconnected by the owner`);
}

async function reconnect(id: string): Promise<void> {
  held.delete(id);
  await saveHeld();
  const p = pairingOf(id);
  if (p) await connect(p);
}

async function setAskFirst(id: string, on: boolean): Promise<void> {
  settings.askFirst[id] = on;
  await saveSettings();
  links.get(id)?.consent(on ? "device" : "kos");
  // A changed rule is the owner at the popup: a KOS that turned this Chrome away is tried again.
  void connectAll(true);
  note(`${hostOf(pairingOf(id) ?? { url: id })}: ${on ? "asks here first" : "its approvals decide"}`);
}

async function changeSettings(patch: Record<string, unknown>): Promise<void> {
  settings = readSettings({ ...settings, ...patch, askFirst: settings.askFirst });
  await saveSettings();
  await badge();
  await paint();
  void connectAll(true);
}

async function hide(text: string): Promise<void> {
  const site = siteOf(text);
  if (!site) throw new Error("That is not a site. Type one like example.com.");
  settings = readSettings({ ...settings, hiddenSites: [...settings.hiddenSites, site] });
  await saveSettings();
  note(`hid ${site}`);
}

async function unhide(site: string): Promise<void> {
  settings = readSettings({ ...settings, hiddenSites: settings.hiddenSites.filter((s) => s !== site) });
  await saveSettings();
}

/** The owner gives KOS a tab, or takes it back. */
async function hand(tab: number, give: boolean): Promise<void> {
  if (give) {
    const t = await chrome.tabs.get(tab);
    if (!isWebUrl(t.url ?? "")) throw new Error("Only a web page can be given to KOS.");
    if (isHidden(t.url ?? "", settings.hiddenSites)) throw new Error("That site is hidden from KOS in this Chrome.");
    handed.add(tab);
    session?.tabs.add(tab);
    // To the KOS at work, or, with none at work, to every KOS that is on: the next to start a session has it.
    const event = { tab: String(tab), url: t.url ?? "", title: t.title ?? "" };
    if (owner) tell("tab.handed", event);
    else for (const link of links.values()) link.event("tab.handed", event);
  } else {
    handed.delete(tab);
    if (tab === beside) beside = undefined;
    if (session?.tabs.delete(tab)) {
      tell("tab.closed", { session: session.info.id, tab: String(tab) });
      overlays.delete(tab);
      pointed.delete(tab);
      restsAt.delete(tab);
      tabUrls.delete(tab);
      loaders.delete(tab);
      mainFrames.delete(tab);
      worldsOf.delete(tab);
      openRequests.delete(tab);
      if (attached.delete(tab)) await chrome.debugger.detach({ tabId: tab }).catch(() => undefined);
      for (const wake of [...commits]) wake();
    }
  }
  await saveHanded();
}

// The side panel.

/**
 * What a KOS says to the side panels talking to it; the chat it shows them
 * is the one they are on. Only `chat.show` says that: a status, an ask or a
 * settled turn names the chat it is about, which may be one the panel left.
 */
function toPanels(method: string, params: Record<string, unknown>, origin: string): void {
  const shown = method === "chat.show" && typeof params["conversation"] === "string" ? params["conversation"] : undefined;
  for (const panel of panels) {
    if (panel.kos !== origin) continue;
    const moved = shown !== undefined && shown !== panel.conversation;
    if (shown !== undefined) panel.conversation = shown;
    panel.port.postMessage({ type: method, ...params });
    if (moved) tellEnded(panel);
  }
}

/** The tab in front in a panel's window, when it is a web page KOS may see. */
async function besideTab(panel: Panel): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, windowId: panel.window });
  const url = tab?.url ?? "";
  return tab?.id !== undefined && isWebUrl(url) && !isHidden(url, settings.hiddenSites) ? tab : undefined;
}

/**
 * The panel's KOS: the one asked for, else the first that is on, else the
 * first there is. A panel found again after the worker woke names the chat
 * it shows, which is still its chat with that KOS until KOS shows another:
 * a Stop pressed then still names it.
 */
function choose(panel: Panel, id: string, conversation = ""): void {
  panel.kos = (pairingOf(id) ?? pairings.find((p) => linkStates.get(p.device)?.state === "online" && !held.has(p.device)) ?? pairings[0])?.device;
  if (conversation && panel.kos === id) panel.conversation = conversation;
  else delete panel.conversation;
  panel.port.postMessage({ type: "kos", id: panel.kos ?? null });
  tellEnded(panel);
  if (panel.kos) links.get(panel.kos)?.event("chat.open", {});
}

async function fromPanel(panel: Panel, message: Record<string, unknown>): Promise<void> {
  switch (message["type"]) {
    case "hello":
      panel.window = Number(message["window"]);
      void watchFront(panel);
      return choose(panel, str(message["kos"]), str(message["conversation"]));
    case "kos":
      return choose(panel, str(message["id"]));
    case "send": {
      const text = str(message["text"]).trim();
      const link = panel.kos ? links.get(panel.kos) : undefined;
      if (!text) return;
      if (!link?.online) throw new Error("KOS is not connected. Connect it from the KOS icon.");
      // Said beside a tab while the panel's chat works in this Chrome: that tab is where KOS works now.
      if (session && owner === panel.kos && session.info.conversation === panel.conversation) {
        const there = await besideTab(panel);
        if (there?.id !== undefined && there.id !== beside) {
          beside = there.id;
          session.tabs.add(there.id);
          tell("tab.handed", { tab: String(there.id), url: there.url ?? "", title: there.title ?? "", focus: true });
        }
      }
      // Which tab the words were said beside, so "this page" means it; a hidden site only as hidden.
      const [front] = await chrome.tabs.query({ active: true, windowId: panel.window });
      const url = front?.url ?? "";
      const web = /^https?:\/\//.test(url);
      const hidden = web && isHidden(url, settings.hiddenSites);
      // What the owner selected there, as a quote from that page, when the panel
      // sends it along and it is still what the page holds: not a stale chip from a page gone.
      const offered = str(record(message["quote"])["text"]).trim();
      const quoted = web && !hidden && front?.id !== undefined && offered && offered === selectionOf(front.id).trim() ? offered : "";
      const where = !front ? undefined : !web ? { kind: "other" } : hidden ? { kind: "hidden" } : { kind: "page", url, title: front.title ?? "" };
      link.event("chat.send", { text, ...(where ? { beside: where } : {}), ...(quoted ? { quote: { text: quoted, from: url } } : {}) });
      return;
    }
    case "decide": {
      if (!panel.kos) return;
      const approved = message["approved"] === true;
      const code = approved && typeof message["code"] === "string" ? message["code"] : undefined;
      const decision = { approval: str(message["approval"]), approved, ...(message["remember"] === true ? { remember: true } : {}) };
      // A one-time code goes to KOS now or not at all: never kept in storage to wait for the line.
      if (code !== undefined) {
        const link = links.get(panel.kos);
        const went = withCode(link?.online === true, decision, code);
        if ("send" in went) return void link!.event("chat.decide", went.send);
        note("chat.decide with a one-time code from the side panel was not sent: KOS's line is down");
        panel.port.postMessage(went.unsent);
        return;
      }
      fromOwner(panel.kos, "chat.decide", decision);
      return;
    }
    case "mode":
    case "mentions":
    case "list":
    case "switch":
    case "models":
    case "model": {
      const { type: _type, ...data } = message;
      if (panel.kos) links.get(panel.kos)?.event(PANEL_ASKS[str(message["type"])]!, data);
      return;
    }
    case "read.answer": {
      const asked = reads.get(str(message["id"]));
      if (asked?.panel === panel) asked.answer(message["granted"] === true);
      return;
    }
    case "consent.answer": {
      const asked = consents.get(str(message["id"]));
      if (asked?.panel !== panel) return;
      const minutes = Math.min(settings.longestMinutes, Math.max(1, Math.round(Number(message["minutes"]) || 0)));
      asked.answer({ allowed: message["allowed"] === true && minutes > 0, minutes, ...(message["site"] === true ? { site: true } : {}) });
      return;
    }
    case "stop": {
      // Stop in the panel: the chat's turn, its session and any ask for one, all at once. A chat not known yet is the one KOS shows.
      if (panel.kos) fromOwner(panel.kos, "chat.stop", panel.conversation ? { chat: panel.conversation } : {}, pressedAt(message["at"]));
      // Said to KOS first, so the ask it takes back is not read as a no; then the prompt comes down here at once.
      for (const asked of consents.values()) if (asked.panel === panel) asked.answer({ allowed: false, minutes: 0, why: "withdrawn" });
      if (session && owner === panel.kos && session.info.conversation === panel.conversation) await end("owner");
      return;
    }
    case "take":
      return pause();
    case "handback":
      return resume();
    default:
      return;
  }
}

async function keepWaiting(next: WaitingEvent[]): Promise<void> {
  waitingForLine = next;
  await chrome.storage.session.set({ [WAITING_KEY]: next });
}

/**
 * A Stop or a decision from a panel, pressed at `at`: told its KOS now, or
 * as soon as its line is back, unless it has lapsed. A Stop says how long
 * ago it was pressed, so KOS does not take it for a turn begun since.
 */
function fromOwner(kos: string, name: "chat.stop" | "chat.decide", data: Record<string, unknown>, at = Date.now()): void {
  const now = Date.now();
  const stop = name === "chat.stop";
  if (lapsed(stop, at, now)) return note(`${name} from the side panel lapsed before it could go`);
  const link = links.get(kos);
  if (link?.online) return link.event(name, stop ? stopWith(data, at, now) : data);
  const next = queued(waitingForLine, { kos, name, data, at });
  note(next === waitingForLine ? `${name} for no chat known yet is not kept for KOS's line` : `${name} from the side panel waits for KOS's line`);
  if (next !== waitingForLine) void keepWaiting(next);
}

/** When the panel says the owner pressed it: a time it gives, never later than now; now when it gives none. */
function pressedAt(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(v, Date.now()) : Date.now();
}

/** The page beside the panel a chat is in, for that chat's KOS and no other, never a hidden site. */
async function pageRead(params: Record<string, unknown>, origin: string): Promise<Record<string, unknown>> {
  const conversation = str(params["conversation"]);
  const panel = [...panels].find((p) => p.kos === origin && p.conversation !== undefined && p.conversation === conversation);
  if (!panel) throw new CallError("no_panel", "the side panel is not open on this chat");
  const [tab] = await chrome.tabs.query({ active: true, windowId: panel.window });
  const url = tab?.url ?? "";
  if (tab?.id === undefined || !isWebUrl(url)) throw new CallError("url", "the tab beside the side panel is not a web page");
  if (isHidden(url, settings.hiddenSites)) throw hiddenError(url);
  const readable = (): Promise<boolean> => chrome.permissions.contains({ origins: [`${new URL(url).origin}/*`] });
  // Not allowed yet: asked in the panel, where a press can grant it, and read once it is.
  if (!(await readable()) && !((await askToRead(panel, new URL(url).host)) && (await readable()))) {
    throw new CallError("permission", "the owner did not let KOS read pages in this Chrome");
  }
  // The tab may have gone elsewhere while the owner was asked, or while it was read: read only the page asked about, and nothing of a hidden one.
  const stillThere = async (): Promise<void> => {
    const now = (await chrome.tabs.get(tab.id!).catch(() => undefined))?.url ?? "";
    if (isHidden(now, settings.hiddenSites)) throw hiddenError(now);
    if (!isWebUrl(now) || new URL(now).origin !== new URL(url).origin) throw new CallError("changed", "the tab beside the side panel went to another page while it was read; ask again");
  };
  await stillThere();
  const [done] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPage, args: [PAGE_TEXT] });
  await stillThere();
  if (!done?.result) throw new CallError("internal", "the page could not be read");
  note(`read ${new URL(url).host} for the side panel`);
  return { ...done.result };
}

/** The owner asked, in the panel, to let KOS read pages; no answer in their wait, or the panel closing, is no. */
function askToRead(panel: Panel, host: string): Promise<boolean> {
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const settle = (granted: boolean): void => {
      if (!reads.delete(id)) return;
      clearTimeout(timer);
      panel.port.postMessage({ type: "read.done", id });
      resolve(granted);
    };
    const timer = setTimeout(() => settle(false), settings.promptWaitSeconds * 1000);
    reads.set(id, { panel, answer: settle });
    panel.port.postMessage({ type: "read.ask", id, host });
  });
}

/**
 * One of the extension's own pages: the popup, the panel, the consent window.
 * Its scripts in web pages carry the same id, and a page's renderer can speak
 * for them, so the id alone is not who is asking.
 */
function ownPage(sender: chrome.runtime.MessageSender | undefined): boolean {
  return sender?.id === chrome.runtime.id && (sender.url ?? "").startsWith(chrome.runtime.getURL(""));
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "panel" || !ownPage(port.sender)) return;
  const panel: Panel = { port, window: chrome.windows.WINDOW_ID_NONE };
  panels.add(panel);
  port.onMessage.addListener((message: Record<string, unknown>) => {
    void ready
      .then(() => fromPanel(panel, message))
      .catch((err: unknown) => port.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) }));
  });
  port.onDisconnect.addListener(() => {
    panels.delete(panel);
    // An ask in a panel that closed has no one to answer it: no.
    for (const asked of consents.values()) if (asked.panel === panel) asked.answer({ allowed: false, minutes: 0, why: "unanswered" });
    for (const asked of reads.values()) if (asked.panel === panel) asked.answer(false);
    // The window's last panel gone: what was selected there is no one's to send.
    if (![...panels].some((p) => p.window === panel.window)) void forgetSelections(panel.window);
    // The last panel closed: a build waiting on it may go in now.
    void maybeReload();
  });
});

// What the owner selects on a page, for the side panel beside it.

/** Each tab's selection by frame, with when it was made: the newest report is the tab's, empty or not. */
const selections = new Map<number, Map<number, { text: string; at: number }>>();
/** Whether the owner lets KOS read pages, as last seen: a page's script still reports after it is taken back. */
let canRead = false;

function selectionOf(tab: number): string {
  const frames = [...(selections.get(tab)?.values() ?? [])];
  return frames.sort((a, b) => b.at - a.at)[0]?.text ?? "";
}

/** What was selected in a window's tabs, forgotten: its last panel closed. */
async function forgetSelections(window: number): Promise<void> {
  for (const tab of await chrome.tabs.query({ windowId: window }).catch(() => [])) if (tab.id !== undefined) selections.delete(tab.id);
}

/** The selection on a window's tab in front, and the site it is on, to the panels open in that window; nothing from a hidden site. */
async function tellSelection(window: number, tab: number): Promise<void> {
  const url = (await chrome.tabs.get(tab).catch(() => undefined))?.url ?? "";
  const text = isHidden(url, settings.hiddenSites) ? "" : selectionOf(tab);
  const from = (text && siteOf(url)) || "";
  for (const panel of panels) if (panel.window === window) panel.port.postMessage({ type: "selection", text, from });
}

/** What a page's selection script said: kept only while a panel is open in its window, never from a hidden site or frame. */
function keepSelection(sender: chrome.runtime.MessageSender, text: string): void {
  const tab = sender.tab;
  if (!canRead || tab?.id === undefined) return;
  if (isHidden(tab.url ?? "", settings.hiddenSites) || isHidden(sender.url ?? "", settings.hiddenSites)) return;
  if (![...panels].some((p) => p.window === tab.windowId)) return;
  const frames = selections.get(tab.id) ?? new Map<number, { text: string; at: number }>();
  frames.set(sender.frameId ?? 0, { text: text.slice(0, 4_000), at: Date.now() });
  selections.set(tab.id, frames);
  if (tab.active) void tellSelection(tab.windowId, tab.id);
}

/**
 * The selection script in each page KOS may read, once the owner has let it
 * read pages, taken back if they take that back. Pages open before then get
 * it when a panel is opened beside them.
 */
async function watchSelections(): Promise<void> {
  const can = await chrome.permissions.contains({ origins: ["<all_urls>"] });
  canRead = can;
  const have = (await chrome.scripting.getRegisteredContentScripts({ ids: [SELECTION_SCRIPT] })).length > 0;
  if (can && !have) await chrome.scripting.registerContentScripts([{ id: SELECTION_SCRIPT, js: ["selection.js"], matches: ["<all_urls>"], runAt: "document_idle", allFrames: true }]);
  if (!can && have) await chrome.scripting.unregisterContentScripts({ ids: [SELECTION_SCRIPT] });
}
chrome.permissions.onAdded.addListener(() => void watchSelections().catch(() => undefined));
chrome.permissions.onRemoved.addListener(() => void watchSelections().catch(() => undefined));
void ready.then(watchSelections).catch(() => undefined);

/** The tab in front of a panel's window, made to report its selection, and what it holds now told. */
async function watchFront(panel: Panel): Promise<void> {
  const [front] = await chrome.tabs.query({ active: true, windowId: panel.window });
  if (front?.id === undefined || !/^https?:\/\//.test(front.url ?? "") || isHidden(front.url ?? "", settings.hiddenSites)) return;
  // Read fresh: what was heard before may be from a selection long gone. Put in, or asked again where it is in
  // already, every frame holding a selection says so and the top frame says what it holds, even nothing.
  selections.delete(front.id);
  if (canRead) await chrome.scripting.executeScript({ target: { tabId: front.id, allFrames: true }, files: ["selection.js"] }).catch(() => undefined);
  void tellSelection(panel.window, front.id);
}

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  for (const panel of panels) if (panel.window === windowId) void watchFront(panel);
  void ready.then(() => tellSelection(windowId, tabId));
});

chrome.runtime.onMessage.addListener((message: Record<string, unknown>, sender, reply: (r: unknown) => void) => {
  // The selection script in the owner's pages says one thing, a selection,
  // and only that is heard from a page; everything else is from the
  // extension's own pages. Settings are read first: a selection may be what
  // woke the worker.
  if (sender.id !== chrome.runtime.id) return false;
  if (message["type"] === "selection") {
    if (sender.tab && !ownPage(sender)) void ready.then(() => keepSelection(sender, str(message["text"])));
    return false;
  }
  if (!ownPage(sender)) return false;
  const id = str(message["id"]);
  const run = async (): Promise<unknown> => {
    await ready;
    switch (message["type"]) {
      case "state":
        return popupState();
      case "pair":
        await pair(
          message["link"] ? parsePairing(str(message["link"])) : { url: kosAddress(str(message["url"])), code: str(message["code"]).trim().toUpperCase() },
          str(message["name"]) || "Chrome",
        );
        return popupState();
      case "unpair":
        await unpair(id);
        return popupState();
      case "disconnect":
        await disconnect(id);
        return popupState();
      case "connect":
        await reconnect(id);
        return popupState();
      case "askFirst":
        await setAskFirst(id, message["on"] === true);
        return popupState();
      case "settings":
        await changeSettings(typeof message["patch"] === "object" && message["patch"] !== null ? (message["patch"] as Record<string, unknown>) : {});
        return popupState();
      case "hide":
        await hide(str(message["site"]));
        return popupState();
      case "unhide":
        await unhide(str(message["site"]));
        return popupState();
      case "hand":
        await hand(Number(message["tab"]), message["give"] === true);
        return popupState();
      case "take":
        await pause();
        return popupState();
      case "handback":
        await resume();
        return popupState();
      case "stop":
        await stopByOwner();
        return popupState();
      case "log":
        return recent();
      case "consent.request":
        return consents.get(id)?.request ?? null;
      case "consent.answer": {
        const asked = consents.get(id);
        const minutes = Math.min(settings.longestMinutes, Math.max(1, Math.round(Number(message["minutes"]) || 0)));
        asked?.answer({ allowed: message["allowed"] === true && minutes > 0, minutes });
        return null;
      }
      default:
        return null;
    }
  };
  run().then(
    (r) => reply({ ok: true, value: r }),
    (err: unknown) => reply({ ok: false, error: err instanceof Error ? err.message : String(err) }),
  );
  return true;
});

chrome.windows.onRemoved.addListener((windowId) => {
  for (const asked of consents.values()) if (asked.window === windowId) asked.answer({ allowed: false, minutes: 0, why: "unanswered" });
});

// Chrome opening: every KOS waits for Connect, if the owner said so.
chrome.runtime.onStartup.addListener(() => {
  void ready.then(async () => {
    if (settings.connectOnStart) return;
    for (const p of pairings) {
      held.add(p.device);
      links.get(p.device)?.stop();
      linkStates.set(p.device, { state: "offline" });
    }
    await saveHeld();
    note("Chrome opened; waiting for Connect");
  });
});

// Installed, updated or reloaded into a new build: Chrome starts the worker for this, and it dials at once.
chrome.runtime.onInstalled.addListener(() => void ready.then(() => connectAll()));

// Awake: connected if paired, and checked every minute in case the worker slept.
chrome.alarms.create("kos", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => void ready.then(() => connectAll()));
void ready.then(() => connectAll());
