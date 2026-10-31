import { parsePairing } from "./address.js";
import { deviceKeys, forgetKeys, publicKey } from "./keys.js";
import { Link, type Hello, type LinkState } from "./link.js";
import { installOverlay, type OverlayState } from "./overlay.js";
import { CallError, PROTOCOL } from "./protocol.js";
import { checkCommand, forwards, isInput, isWebUrl } from "./relay.js";
import { Session, type EndReason, type PageInput } from "./session.js";
import { CONSENT_MS } from "./timing.js";

/**
 * The extension's worker: paired with one KOS, it answers that KOS's calls
 * in the tabs of a session the owner allowed, and nowhere else.
 *
 * A session starts when KOS asks and the owner says yes, in a window the
 * extension opens. KOS works in a window of its own, its tabs grouped as
 * KOS, and in tabs the owner hands it from the popup. Each of those tabs is
 * driven over Chrome's debugger, with only the commands KOS's hands use,
 * and wears the overlay. The owner's own click or key in one takes it over
 * until they hand it back. The session ends at its time, when idle, on
 * Stop, when the owner closes Chrome's debugging bar, and when KOS or the
 * connection goes.
 */

export interface Paired {
  url: string;
  device: string;
  hostKey: string;
  name: string;
}

/** What the popup is told. */
export interface PopupState {
  paired: { url: string; name: string } | null;
  link: { state: LinkState; detail?: string };
  session: { task: string; requester: string; until: number; paused: boolean } | null;
  handed: number[];
}

export interface ConsentRequest {
  id: string;
  task: string;
  requester: string;
  minutes: number;
}

/** A session nothing has asked of for this long ends. */
const IDLE_MS = 5 * 60_000;
/** The most a session may run for, whatever KOS asks. */
const LONGEST_MINUTES = 120;
const WORLD = "kos";
const BINDING = "kosOverlay";
const GROUP = "KOS";

let paired: Paired | undefined;
let link: Link | undefined;
let linkState: PopupState["link"] = { state: "offline" };
let session: Session | undefined;
let ticker: ReturnType<typeof setInterval> | undefined;
/** Tabs the owner has handed KOS: they join the next session, and the live one. */
const handed = new Set<number>();
const attached = new Set<number>();
/** Each tab's overlay, by the world it runs in. */
const overlays = new Map<number, number>();
const consents = new Map<string, { request: ConsentRequest; answer: (a: { allowed: boolean; minutes: number }) => void; window?: number }>();

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// Kept across the worker's sleeps: the pairing in local storage, the handed tabs and KOS's window in session storage.
async function load(): Promise<void> {
  const local = await chrome.storage.local.get("paired");
  paired = isRecord(local["paired"]) ? (local["paired"] as unknown as Paired) : undefined;
  const kept = await chrome.storage.session.get(["handed"]);
  for (const tab of Array.isArray(kept["handed"]) ? (kept["handed"] as number[]) : []) handed.add(tab);
}

async function saveHanded(): Promise<void> {
  await chrome.storage.session.set({ handed: [...handed] });
}

function hello(): Hello {
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform;
  return { app: { version: chrome.runtime.getManifest().version, platform: "chrome", os: platform || "unknown" }, consent: "device", permissions: { tabs: true }, displays: [] };
}

async function connect(): Promise<void> {
  if (!paired) return;
  if (link) return link.start();
  const keys = await deviceKeys();
  link = new Link({
    url: paired.url,
    device: paired.device,
    hostKey: paired.hostKey,
    keys,
    hello,
    onCall: answer,
    onState: (state, detail) => {
      linkState = { state, ...(detail ? { detail } : {}) };
      // A session lives on its connection: KOS gone, KOS's hands gone.
      if (state !== "online" && state !== "connecting" && session) void end("host");
      void badge();
    },
  });
  link.start();
}

async function badge(): Promise<void> {
  const text = session ? (session.paused ? "YOU" : "ON") : "";
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: session?.paused ? "#f59e0b" : "#8b5cf6" });
}

// KOS's calls.

async function answer(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  switch (method) {
    case "session.begin":
      return begin(params);
    case "session.end":
      live(params);
      await end("host");
      return {};
    case "tabs.list":
      live(params);
      return { tabs: await listTabs() };
    case "tabs.open":
      live(params);
      return { tab: String(await openTab(str(params["url"]) || "about:blank")) };
    case "tabs.close": {
      const s = live(params);
      const tab = tabOf(s, params);
      await chrome.tabs.remove(tab);
      return {};
    }
    case "cdp.send":
      return relay(params);
    default:
      throw new CallError("bad_request", `${method} is not something this extension does`);
  }
}

/** The live session a call names, or a refusal. */
function live(params: Record<string, unknown>): Session {
  if (!session || params["session"] !== session.info.id) throw new CallError("no_session", "no session is live in this Chrome");
  session.touch(Date.now());
  return session;
}

function tabOf(s: Session, params: Record<string, unknown>): number {
  const tab = Number(params["tab"]);
  if (!Number.isInteger(tab) || !s.tabs.has(tab)) throw new CallError("tab", "that tab is not one KOS was given");
  return tab;
}

async function begin(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = str(params["session"]);
  if (!id) throw new CallError("bad_request", "session required");
  if (session) throw new CallError("busy", "KOS is already working in this Chrome");
  const asked = Math.min(LONGEST_MINUTES, Math.max(1, Math.round(Number(params["minutes"]) || 15)));
  const request: ConsentRequest = { id, task: str(params["task"]) || "a task", requester: str(params["requester"]) || "KOS", minutes: asked };
  const decided = await askOwner(request);
  if (!decided.allowed) return { granted: false };
  const now = Date.now();
  const conversation = str(params["conversation"]);
  session = new Session({ id, task: request.task, requester: request.requester, ...(conversation ? { conversation } : {}), until: now + decided.minutes * 60_000 }, now);
  for (const tab of handed) session.tabs.add(tab);
  clearInterval(ticker);
  ticker = setInterval(() => {
    const reason = session?.over(Date.now(), IDLE_MS);
    if (reason) void end(reason);
  }, 1_000);
  await badge();
  return { granted: true, until: session.info.until };
}

/** The owner asked, in a window of the extension's own; no answer in a minute is no. */
function askOwner(request: ConsentRequest): Promise<{ allowed: boolean; minutes: number }> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (a: { allowed: boolean; minutes: number }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const asked = consents.get(request.id);
      consents.delete(request.id);
      if (asked?.window !== undefined) void chrome.windows.remove(asked.window).catch(() => undefined);
      resolve(a);
    };
    const timer = setTimeout(() => settle({ allowed: false, minutes: 0 }), CONSENT_MS);
    const entry: { request: ConsentRequest; answer: (a: { allowed: boolean; minutes: number }) => void; window?: number } = { request, answer: settle };
    consents.set(request.id, entry);
    void chrome.windows
      .create({ url: chrome.runtime.getURL(`consent.html?id=${encodeURIComponent(request.id)}`), type: "popup", width: 440, height: 500, focused: true })
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
  link?.event("session.ended", { session: ended.info.id, reason });
  await badge();
}

async function listTabs(): Promise<{ id: string; url: string; title: string; handed?: true }[]> {
  const s = session!;
  const out: { id: string; url: string; title: string; handed?: true }[] = [];
  for (const id of s.tabs) {
    const tab = await chrome.tabs.get(id).catch(() => undefined);
    if (tab) out.push({ id: String(id), url: tab.url ?? "", title: tab.title ?? "", ...(handed.has(id) ? { handed: true as const } : {}) });
  }
  return out;
}

/** A tab of KOS's own, in its window (made the first time, out of the owner's way), grouped as KOS. */
async function openTab(url: string): Promise<number> {
  if (!isWebUrl(url)) throw new CallError("url", "only web pages (http and https) open in your Chrome");
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
  await chrome.tabGroups.update(groupId, { title: GROUP, color: "purple" });
  session!.tabs.add(tab.id!);
  await attach(tab.id!);
  return tab.id!;
}

/** A tab under KOS's hands: the debugger on it, and the overlay in a world of its own. */
async function attach(tab: number): Promise<void> {
  if (attached.has(tab)) return;
  await chrome.debugger.attach({ tabId: tab }, "1.3");
  attached.add(tab);
  const send = (method: string, params: Record<string, unknown> = {}): Promise<unknown> => chrome.debugger.sendCommand({ tabId: tab }, method, params);
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Runtime.addBinding", { name: BINDING, executionContextName: WORLD });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `(${installOverlay.toString()})()`, worldName: WORLD, runImmediately: true });
}

async function relay(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const s = live(params);
  const tab = tabOf(s, params);
  const method = str(params["method"]);
  const args = isRecord(params["params"]) ? params["params"] : {};
  checkCommand(method, args);
  if (s.paused && (isInput(method) || method === "Page.navigate")) throw new CallError("paused", "the owner has taken over this tab; wait for them to hand it back");
  await attach(tab);
  if (isInput(method)) s.dispatching(method, args, Date.now());
  try {
    return ((await chrome.debugger.sendCommand({ tabId: tab }, method, args)) as Record<string, unknown> | undefined) ?? {};
  } catch (err) {
    throw new CallError("cdp", err instanceof Error ? err.message : String(err));
  }
}

// The owner's hands.

function overlayState(): OverlayState {
  return { task: session?.info.task ?? "", paused: session?.paused ?? false, until: session?.info.until ?? 0 };
}

async function paint(): Promise<void> {
  const expression = `window.__kos && window.__kos.set(${JSON.stringify(overlayState())})`;
  for (const [tab, world] of overlays) await chrome.debugger.sendCommand({ tabId: tab }, "Runtime.evaluate", { expression, contextId: world }).catch(() => undefined);
}

async function pause(): Promise<void> {
  if (!session || session.paused) return;
  session.paused = true;
  link?.event("session.paused", { session: session.info.id, reason: "owner" });
  await Promise.all([paint(), badge()]);
}

async function resume(): Promise<void> {
  if (!session?.paused) return;
  session.paused = false;
  link?.event("session.resumed", { session: session.info.id });
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
      if (session && !session.paused && session.isOwners(message as unknown as PageInput, Date.now())) await pause();
      return;
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
  if (forwards(method)) link?.event("cdp.event", { session: session.info.id, tab: String(tab), method, params: p });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  const tab = source.tabId;
  if (tab === undefined) return;
  attached.delete(tab);
  overlays.delete(tab);
  // Closing Chrome's debugging bar is the owner saying stop.
  if (reason === "canceled_by_user") void end("detached");
});

chrome.tabs.onRemoved.addListener((tab) => {
  if (handed.delete(tab)) void saveHanded();
  if (!session?.tabs.has(tab)) return;
  session.tabs.delete(tab);
  link?.event("tab.closed", { session: session.info.id, tab: String(tab) });
});

// The popup and the consent window.

async function popupState(): Promise<PopupState> {
  return {
    paired: paired ? { url: paired.url, name: paired.name } : null,
    link: linkState,
    session: session ? { task: session.info.task, requester: session.info.requester, until: session.info.until, paused: session.paused } : null,
    handed: [...handed],
  };
}

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
  link?.stop();
  link = undefined;
  paired = { url, device: body["device"], hostKey: body["hostKey"], name };
  await chrome.storage.local.set({ paired });
  await connect();
}

async function unpair(): Promise<void> {
  await end("owner");
  link?.stop();
  link = undefined;
  paired = undefined;
  linkState = { state: "offline" };
  await chrome.storage.local.remove("paired");
  await forgetKeys();
}

/** The owner gives KOS a tab, or takes it back. */
async function hand(tab: number, give: boolean): Promise<void> {
  if (give) {
    const t = await chrome.tabs.get(tab);
    if (!isWebUrl(t.url ?? "")) throw new Error("Only a web page can be given to KOS.");
    handed.add(tab);
    session?.tabs.add(tab);
    link?.event("tab.handed", { tab: String(tab), url: t.url ?? "", title: t.title ?? "" });
  } else {
    handed.delete(tab);
    if (session?.tabs.delete(tab)) {
      link?.event("tab.closed", { session: session.info.id, tab: String(tab) });
      overlays.delete(tab);
      if (attached.delete(tab)) await chrome.debugger.detach({ tabId: tab }).catch(() => undefined);
    }
  }
  await saveHanded();
}

chrome.runtime.onMessage.addListener((message: Record<string, unknown>, sender, reply: (r: unknown) => void) => {
  // Only the extension's own pages speak to it.
  if (sender.id !== chrome.runtime.id) return false;
  const run = async (): Promise<unknown> => {
    switch (message["type"]) {
      case "state":
        return popupState();
      case "pair":
        await pair(str(message["link"]), str(message["name"]) || "Chrome");
        return popupState();
      case "unpair":
        await unpair();
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
      case "consent.request":
        return consents.get(str(message["id"]))?.request ?? null;
      case "consent.answer": {
        const asked = consents.get(str(message["id"]));
        const minutes = Math.min(LONGEST_MINUTES, Math.max(1, Math.round(Number(message["minutes"]) || 0)));
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

// Awake: connected if paired, and checked every minute in case the worker slept.
chrome.alarms.create("kos", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => void connect());
void load().then(connect);
