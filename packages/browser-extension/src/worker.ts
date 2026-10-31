import { parsePairing } from "./address.js";
import { deviceKeys, forgetKeys, publicKey } from "./keys.js";
import { Link, type Hello, type LinkState } from "./link.js";
import { note, recent } from "./log.js";
import { installOverlay, type OverlayState } from "./overlay.js";
import { readPage } from "./page.js";
import { adding, readPairings, removing, replacedBy, type Paired } from "./pairings.js";
import { CallError, PROTOCOL } from "./protocol.js";
import { checkCommand, forwards, isInput, isWebUrl } from "./relay.js";
import { Session, type EndReason, type PageInput } from "./session.js";
import { DEFAULTS, asksFirst, isHidden, readSettings, siteOf, type ExtensionSettings } from "./settings.js";

/**
 * The extension's worker: paired with one KOS or several, it answers each
 * one's calls in the tabs of a session the owner allowed, and nowhere else.
 *
 * Each KOS is its own pairing and its own line, as KOS Device keeps them on a
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
}

/** What the popup is told. */
export interface PopupState {
  kos: KosState[];
  /** `kos` names the KOS it is for when there are several; `beside` is the tab beside the side panel it works in. */
  session: { task: string; requester: string; until: number; paused: boolean; kos?: string; beside?: number } | null;
  handed: number[];
  settings: Omit<ExtensionSettings, "askFirst">;
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
  answer: (a: { allowed: boolean; minutes: number }) => void;
  window?: number;
  /** Asked in a side panel rather than a window of its own. */
  panel?: Panel;
}

/** As much of a page's text as the panel's chat reads in one go. */
const PAGE_TEXT = 60_000;
const PANEL_CALLS = new Set(["chat.show", "chat.status", "chat.ask", "chat.settled", "chat.chats", "chat.models"]);
/** What a panel asks its KOS for, passed on as it is: the chats to switch to, a switch, the models, a model. */
const PANEL_ASKS: Record<string, string> = { list: "chat.list", switch: "chat.switch", models: "chat.models", model: "chat.model", auto: "chat.auto" };

const WORLD = "kos";
const BINDING = "kosOverlay";
const GROUP = "KOS";

let pairings: Paired[] = [];
let settings: ExtensionSettings = DEFAULTS;
/** KOS the owner disconnected, kept across the worker's sleeps. */
let held = new Set<string>();
const links = new Map<string, Link>();
const linkStates = new Map<string, { state: LinkState; detail?: string }>();
let session: Session | undefined;
/** The KOS whose session it is, or which is asking the owner for one. */
let owner: string | undefined;
let ticker: ReturnType<typeof setInterval> | undefined;
let badgeShown = "";
/** Tabs the owner has handed KOS: they join the next session, and the live one. */
const handed = new Set<number>();
const attached = new Set<number>();
/** Each tab's overlay, by the world it runs in. */
const overlays = new Map<number, number>();
/** Each KOS tab's address as it changes, so one on a hidden site tells KOS nothing. */
const tabUrls = new Map<number, string>();
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
/** What to call a KOS to the owner, when there is more than one to tell apart. */
const kosName = (id: string | undefined): string | undefined => (pairings.length > 1 ? pairingOf(id) && hostOf(pairingOf(id)!) : undefined);

// Kept across the worker's sleeps: pairings, settings and who is held in local storage, the handed tabs and KOS's window in session storage.
async function load(): Promise<void> {
  const local = await chrome.storage.local.get(["pairings", "paired", "settings", "held"]);
  pairings = readPairings(local["pairings"], local["paired"]);
  if (!Array.isArray(local["pairings"]) && pairings.length) {
    await chrome.storage.local.set({ pairings });
    await chrome.storage.local.remove("paired");
    note(`moved the one pairing, ${hostOf(pairings[0]!)}, into the list`);
  }
  settings = readSettings(local["settings"]);
  held = new Set(Array.isArray(local["held"]) ? (local["held"] as unknown[]).filter((v): v is string => typeof v === "string") : []);
  const kept = await chrome.storage.session.get(["handed", "bar"]);
  for (const tab of Array.isArray(kept["handed"]) ? (kept["handed"] as number[]) : []) handed.add(tab);
  if (typeof kept["bar"] === "object" && kept["bar"] !== null) barPlace = kept["bar"] as typeof barPlace;
}
const ready = load();

const savePairings = (): Promise<void> => chrome.storage.local.set({ pairings });
const saveSettings = (): Promise<void> => chrome.storage.local.set({ settings });
const saveHeld = (): Promise<void> => chrome.storage.local.set({ held: [...held] });
const saveHanded = (): Promise<void> => chrome.storage.session.set({ handed: [...handed] });

function hello(id: string): Hello {
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform;
  return {
    app: { version: chrome.runtime.getManifest().version, platform: "chrome", os: platform || "unknown" },
    consent: asksFirst(settings, id) ? "device" : "kos",
    permissions: { tabs: true },
    displays: [],
  };
}

/** Every KOS's line, up unless the owner held it. */
async function connectAll(): Promise<void> {
  for (const p of pairings) if (!held.has(p.device)) await connect(p);
}

async function connect(p: Paired): Promise<void> {
  const id = p.device;
  const kept = links.get(id);
  if (kept) return kept.start();
  const keys = await deviceKeys();
  const link = new Link({
    url: p.url,
    device: id,
    hostKey: p.hostKey,
    keys,
    hello: () => hello(id),
    onCall: (method, params) => answer(method, params, id),
    onState: (state, detail) => {
      const was = linkStates.get(id)?.state;
      linkStates.set(id, { state, ...(detail ? { detail } : {}) });
      if (state !== was) note(`${hostOf(p)}: ${state}${detail ? ` (${detail})` : ""}`);
      // A panel open on this KOS is shown its chat as soon as there is a line to show it on.
      if (state === "online" && state !== was) for (const panel of panels) if (panel.kos === id) links.get(id)?.event("chat.open", {});
      // A session lives on its connection: its KOS gone, KOS's hands gone; an ask it made is withdrawn.
      if (state !== "online" && state !== "connecting" && owner === id) {
        if (session) void end("host");
        for (const asked of consents.values()) if (asked.origin === id) asked.answer({ allowed: false, minutes: 0 });
      }
    },
  });
  links.set(id, link);
  link.start();
}

/** The KOS icon says a session is on, the owner has it, or how long it has left. */
function badgeText(): string {
  if (!session) return "";
  if (session.paused) return "YOU";
  if (!settings.timeOnIcon) return "ON";
  const m = Math.max(1, Math.ceil((session.info.until - Date.now()) / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`;
}

async function badge(): Promise<void> {
  const text = badgeText();
  badgeShown = text;
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: session?.paused ? "#e6b84d" : "#7c9cff" });
  await chrome.action.setBadgeTextColor({ color: "#0b0e14" });
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
    case "session.end":
      live(params, origin);
      await end("host");
      return {};
    case "tabs.list":
      live(params, origin);
      return { tabs: await listTabs() };
    case "tabs.open":
      live(params, origin);
      return { tab: String(await openTab(str(params["url"]) || "about:blank")) };
    case "tabs.close": {
      const s = live(params, origin);
      const tab = tabOf(s, params);
      await chrome.tabs.remove(tab);
      return {};
    }
    case "cdp.send":
      return relay(params, origin);
    case "page.read":
      return pageRead(params, origin);
    default:
      if (PANEL_CALLS.has(method)) {
        toPanels(method, params, origin);
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
    const request: ConsentRequest = {
      id,
      task: str(params["task"]) || "a task",
      requester: str(params["requester"]) || "KOS",
      minutes: asked,
      longest: settings.longestMinutes,
      waitMs: settings.promptWaitSeconds * 1000,
      ...(kosName(origin) ? { kos: kosName(origin)! } : {}),
    };
    note(`${hostOf(pairingOf(origin) ?? { url: origin })} asks for ${asked} min, from ${request.requester}`);
    let minutes = asked;
    if (asksFirst(settings, origin)) {
      const decided = await askOwner(request, origin, panel);
      if (!decided.allowed) {
        note("not allowed");
        return { granted: false };
      }
      minutes = decided.minutes;
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
    ticker = setInterval(() => {
      const reason = session?.over(Date.now(), settings.idleMinutes * 60_000);
      if (reason) return void end(reason);
      if (badgeText() !== badgeShown) void badge();
    }, 1_000);
    note(`live for ${minutes} min`);
    await badge();
    return { granted: true, until: session.info.until };
  } finally {
    if (!session) owner = undefined;
  }
}

/** The owner asked, in the side panel the chat is in or a window of the extension's own; no answer in the owner's wait is no. */
function askOwner(request: ConsentRequest, origin: string, panel?: Panel): Promise<{ allowed: boolean; minutes: number }> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (a: { allowed: boolean; minutes: number }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const asked = consents.get(request.id);
      consents.delete(request.id);
      if (asked?.window !== undefined) void chrome.windows.remove(asked.window).catch(() => undefined);
      asked?.panel?.port.postMessage({ type: "consent.done", id: request.id });
      resolve(a);
    };
    const timer = setTimeout(() => settle({ allowed: false, minutes: 0 }), request.waitMs);
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
      .catch(() => settle({ allowed: false, minutes: 0 }));
  });
}

async function end(reason: EndReason): Promise<void> {
  const ended = session;
  if (!ended) return;
  session = undefined;
  clearInterval(ticker);
  for (const tab of [...attached]) {
    const world = overlays.get(tab);
    if (world !== undefined) await chrome.debugger.sendCommand({ tabId: tab }, "Runtime.evaluate", { expression: "window.__kos && window.__kos.remove()", contextId: world }).catch(() => undefined);
    await chrome.debugger.detach({ tabId: tab }).catch(() => undefined);
  }
  attached.clear();
  overlays.clear();
  beside = undefined;
  tell("session.ended", { session: ended.info.id, reason });
  owner = undefined;
  note(`ended: ${reason}`);
  await badge();
}

async function listTabs(): Promise<{ id: string; url: string; title: string; handed?: true; focus?: true; hidden?: true }[]> {
  const s = session!;
  const out: { id: string; url: string; title: string; handed?: true; focus?: true; hidden?: true }[] = [];
  for (const id of s.tabs) {
    const tab = await chrome.tabs.get(id).catch(() => undefined);
    if (!tab) continue;
    // The tab beside the side panel the owner gave by speaking from it, as one they handed.
    const mark = { ...(handed.has(id) || id === beside ? { handed: true as const } : {}), ...(id === beside ? { focus: true as const } : {}) };
    // A tab on a hidden site is KOS's to know of, and nothing more.
    if (isHidden(tab.url ?? "", settings.hiddenSites)) out.push({ id: String(id), url: "", title: "Hidden from KOS", hidden: true, ...mark });
    else out.push({ id: String(id), url: tab.url ?? "", title: tab.title ?? "", ...mark });
  }
  return out;
}

/** A tab of KOS's own, in its window (made the first time, out of the owner's way), grouped as KOS. */
async function openTab(url: string): Promise<number> {
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
  session!.tabs.add(tab.id!);
  await attach(tab.id!);
  return tab.id!;
}

/** A tab under KOS's hands: the debugger on it, and the overlay in a world of its own. */
async function attach(tab: number): Promise<void> {
  if (attached.has(tab)) return;
  await chrome.debugger.attach({ tabId: tab }, "1.3");
  attached.add(tab);
  const t = await chrome.tabs.get(tab).catch(() => undefined);
  if (t?.url) tabUrls.set(tab, t.url);
  const send = (method: string, params: Record<string, unknown> = {}): Promise<unknown> => chrome.debugger.sendCommand({ tabId: tab }, method, params);
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Runtime.addBinding", { name: BINDING, executionContextName: WORLD });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `(${installOverlay.toString()})()`, worldName: WORLD, runImmediately: true });
}

async function relay(params: Record<string, unknown>, origin: string): Promise<Record<string, unknown>> {
  const s = live(params, origin);
  const tab = tabOf(s, params);
  const method = str(params["method"]);
  const args = (typeof params["params"] === "object" && params["params"] !== null ? params["params"] : {}) as Record<string, unknown>;
  checkCommand(method, args);
  // Not a look, a click or a word on a hidden site, and no way there.
  const url = (await chrome.tabs.get(tab).catch(() => undefined))?.url ?? "";
  if (isHidden(url, settings.hiddenSites)) throw hiddenError(url);
  if (method === "Page.navigate" && isHidden(str(args["url"]), settings.hiddenSites)) throw hiddenError(str(args["url"]));
  if (s.paused && (isInput(method) || method === "Page.navigate")) throw new CallError("paused", "the owner has taken over this tab; wait for them to hand it back");
  await attach(tab);
  if (isInput(method)) s.dispatching(method, args, Date.now());
  try {
    return ((await chrome.debugger.sendCommand({ tabId: tab }, method, args)) as Record<string, unknown> | undefined) ?? {};
  } catch (err) {
    throw new CallError("cdp", err instanceof Error ? err.message : String(err));
  }
}

/** Whether a tab's event would tell KOS of a hidden site: the tab is on one, or the event is a way to one. */
function fromHidden(tab: number, params: Record<string, unknown>): boolean {
  const frame = params["frame"] as { url?: unknown } | undefined;
  const request = params["request"] as { url?: unknown } | undefined;
  return [tabUrls.get(tab), frame?.url, request?.url, params["documentURL"]].some((u) => typeof u === "string" && isHidden(u, settings.hiddenSites));
}

// The owner's hands.

function overlayState(): OverlayState {
  return { task: session?.info.task ?? "", paused: session?.paused ?? false, until: session?.info.until ?? 0, ...barPlace };
}

async function paint(): Promise<void> {
  const expression = `window.__kos && window.__kos.set(${JSON.stringify(overlayState())})`;
  for (const [tab, world] of overlays) await chrome.debugger.sendCommand({ tabId: tab }, "Runtime.evaluate", { expression, contextId: world }).catch(() => undefined);
}

async function pause(): Promise<void> {
  if (!session || session.paused) return;
  session.paused = true;
  tell("session.paused", { session: session.info.id, reason: "owner" });
  note("paused: the owner took over");
  await Promise.all([paint(), badge()]);
}

async function resume(): Promise<void> {
  if (!session?.paused) return;
  session.paused = false;
  tell("session.resumed", { session: session.info.id });
  note("resumed");
  await Promise.all([paint(), badge()]);
}

async function fromOverlay(tab: number, world: number, payload: string): Promise<void> {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return;
  }
  switch (message["kind"]) {
    case "hello":
      overlays.set(tab, world);
      await chrome.debugger.sendCommand({ tabId: tab }, "Runtime.evaluate", { expression: `window.__kos && window.__kos.set(${JSON.stringify(overlayState())})`, contextId: world }).catch(() => undefined);
      return;
    case "input":
      // The owner may scroll a KOS tab freely, if they said so.
      if (settings.takeover === "clicksAndKeys" && message["type"] === "wheel") return;
      if (session && !session.paused && session.isOwners(message as unknown as PageInput, Date.now())) await pause();
      return;
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
      return end("owner");
    default:
      return;
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tab = source.tabId;
  if (tab === undefined || !session?.tabs.has(tab)) return;
  const p = (params ?? {}) as Record<string, unknown>;
  if (method === "Runtime.bindingCalled") {
    if (p["name"] === BINDING) void fromOverlay(tab, Number(p["executionContextId"]), str(p["payload"]));
    return;
  }
  if (forwards(method) && !fromHidden(tab, p)) tell("cdp.event", { session: session.info.id, tab: String(tab), method, params: p });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  const tab = source.tabId;
  if (tab === undefined) return;
  attached.delete(tab);
  overlays.delete(tab);
  // Closing Chrome's debugging bar is the owner saying stop.
  if (reason === "canceled_by_user") void end("detached");
});

chrome.tabs.onUpdated.addListener((tab, change) => {
  if (change.url && attached.has(tab)) tabUrls.set(tab, change.url);
});

chrome.tabs.onRemoved.addListener((tab) => {
  tabUrls.delete(tab);
  if (tab === beside) beside = undefined;
  if (handed.delete(tab)) void saveHanded();
  if (!session?.tabs.has(tab)) return;
  session.tabs.delete(tab);
  tell("tab.closed", { session: session.info.id, tab: String(tab) });
});

// The popup and the consent window.

function popupState(): PopupState {
  const { askFirst: _perKos, ...shown } = settings;
  return {
    kos: pairings.map((p) => {
      const line = linkStates.get(p.device) ?? { state: "offline" as const };
      return {
        id: p.device,
        url: p.url,
        host: hostOf(p),
        name: p.name,
        link: line.state,
        ...(line.detail ? { detail: line.detail } : {}),
        askFirst: asksFirst(settings, p.device),
        held: held.has(p.device),
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
        }
      : null,
    handed: [...handed],
    settings: shown,
  };
}

/** Paired with a KOS: another line beside the rest, or in place of the one to the same KOS, which keeps its rule about asking first. */
async function pair(text: string, name: string): Promise<void> {
  const { url, code } = parsePairing(text);
  const keys = await deviceKeys();
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
  // That KOS made a new device for this pairing; the old one goes from its list.
  for (const old of replaced) await forgetLine(old.device, true);
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
  // One key answers every KOS; with none left, the next pairing makes a new one.
  if (!pairings.length) await forgetKeys();
  note(`unpaired from ${p ? hostOf(p) : id}`);
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
  note(`${hostOf(pairingOf(id) ?? { url: id })}: ${on ? "asks here first" : "its approvals decide"}`);
}

async function changeSettings(patch: Record<string, unknown>): Promise<void> {
  settings = readSettings({ ...settings, ...patch, askFirst: settings.askFirst });
  await saveSettings();
  await badge();
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
      if (attached.delete(tab)) await chrome.debugger.detach({ tabId: tab }).catch(() => undefined);
    }
  }
  await saveHanded();
}

// The side panel.

/** What a KOS says to the side panels talking to it; the chat it shows them is the one they are on. */
function toPanels(method: string, params: Record<string, unknown>, origin: string): void {
  for (const panel of panels) {
    if (panel.kos !== origin) continue;
    if (typeof params["conversation"] === "string") panel.conversation = params["conversation"];
    panel.port.postMessage({ type: method, ...params });
  }
}

/** The tab in front in a panel's window, when it is a web page KOS may see. */
async function besideTab(panel: Panel): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, windowId: panel.window });
  const url = tab?.url ?? "";
  return tab?.id !== undefined && isWebUrl(url) && !isHidden(url, settings.hiddenSites) ? tab : undefined;
}

/** The panel's KOS: the one asked for, else the first that is on, else the first there is. */
function choose(panel: Panel, id: string): void {
  panel.kos = (pairingOf(id) ?? pairings.find((p) => linkStates.get(p.device)?.state === "online" && !held.has(p.device)) ?? pairings[0])?.device;
  delete panel.conversation;
  panel.port.postMessage({ type: "kos", id: panel.kos ?? null });
  if (panel.kos) links.get(panel.kos)?.event("chat.open", {});
}

async function fromPanel(panel: Panel, message: Record<string, unknown>): Promise<void> {
  switch (message["type"]) {
    case "hello":
      panel.window = Number(message["window"]);
      return choose(panel, str(message["kos"]));
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
      const where = !front ? undefined : !/^https?:\/\//.test(url) ? { kind: "other" } : isHidden(url, settings.hiddenSites) ? { kind: "hidden" } : { kind: "page", url, title: front.title ?? "" };
      link.event("chat.send", { text, ...(where ? { beside: where } : {}) });
      return;
    }
    case "decide":
      if (panel.kos) links.get(panel.kos)?.event("chat.decide", { approval: str(message["approval"]), approved: message["approved"] === true, ...(message["remember"] === true ? { remember: true } : {}) });
      return;
    case "auto":
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
      asked.answer({ allowed: message["allowed"] === true && minutes > 0, minutes });
      return;
    }
    default:
      return;
  }
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
  const [done] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPage, args: [PAGE_TEXT] });
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

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "panel" || port.sender?.id !== chrome.runtime.id) return;
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
    for (const asked of consents.values()) if (asked.panel === panel) asked.answer({ allowed: false, minutes: 0 });
    for (const asked of reads.values()) if (asked.panel === panel) asked.answer(false);
  });
});

chrome.runtime.onMessage.addListener((message: Record<string, unknown>, sender, reply: (r: unknown) => void) => {
  // Only the extension's own pages speak to it.
  if (sender.id !== chrome.runtime.id) return false;
  const id = str(message["id"]);
  const run = async (): Promise<unknown> => {
    await ready;
    switch (message["type"]) {
      case "state":
        return popupState();
      case "pair":
        await pair(str(message["link"]), str(message["name"]) || "Chrome");
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
        await end("owner");
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
  for (const asked of consents.values()) if (asked.window === windowId) asked.answer({ allowed: false, minutes: 0 });
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

// Awake: connected if paired, and checked every minute in case the worker slept.
chrome.alarms.create("kos", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => void ready.then(connectAll));
void ready.then(connectAll);
