import { PICTURE, Page, SecretRefused, echoPatterns, sendEach, type Call, type FilledValue, type Kin, type SecretPut, type Session as TabSession, type Tab } from "@kos/browser";
import { turnStop, type BrowserElsewhere, type PageSpot, type TabInfo } from "@kos/harness";

import { kindOf, type DeviceHub, type Session } from "./hub.js";
import { DeviceError } from "./link.js";
import type { DeviceEvent } from "./protocol.js";
import type { Device } from "./store.js";
import { endingText, refusalText } from "./tools.js";

/**
 * The owner's own Chrome, as a browser KOS's tools can work in.
 *
 * A conversation that has a session on a paired Chrome (KOS for Chrome)
 * browses there: its browser.* calls go to a tab of that Chrome, through the
 * extension, driven by the same hands as KOS's own Chrome. The tabs are the
 * session's: the ones KOS opened in its window there, and the ones the owner
 * handed it. While the owner has taken over, the hands wait. A session
 * started from the side panel works in the tab beside it, where the owner is
 * looking, rather than in a window of KOS's own.
 */

interface Kept {
  url: string;
  title: string;
  handed: boolean;
  /** The tab beside the side panel the owner is talking from. */
  focus?: boolean;
}

/**
 * What the host knows of the owner's secrets, as the pages of the owner's
 * Chrome need it (SecretsRegistry): every saved value, cleaned out of what
 * KOS reads back; those a page's site may be shown, to mask its pictures;
 * and why no script of KOS's runs on an origin, if none may.
 */
export interface PageSecrets {
  saved(): readonly FilledValue[];
  savedFor(origins: readonly string[]): readonly FilledValue[];
  evalBlocked(origin: string): string | undefined;
}

/** One conversation's borrowed Chrome: its tabs, the one it is on, and a page for each it has driven. */
interface Borrowed {
  session: string;
  tabs: Map<string, Kept>;
  current?: string;
  pages: Map<string, Page>;
  /** Every value filled in any of its tabs, for the session's life: each tab's pictures and words are cleaned of all of them (see Kin). */
  filled: FilledValue[];
  /** The extension sends pictures the size of the tab: one from before it made them small itself. */
  fullPictures?: boolean;
  /** How often the page has moved under the agent: navigated, taken over, handed back. */
  moved: number;
  /** Whether the owner had the Chrome when last heard. */
  paused?: boolean;
}

/** Time for a command's round trip through the extension, beyond the command's own. */
const RELAY_SLACK_MS = 5_000;
/** Commands in one cdp.batch, at most (BATCH_MAX in the extension's worker). */
const BATCH_MAX = 100;
/** How long the extension may take to check a field and put a secret into it. */
const SECRET_FILL_MS = 20_000;
/** The extension's refusals of a fill that are KOS's own (SecretRefused): recorded as refused:<code>, the words the extension's. */
const FILL_REFUSALS: ReadonlySet<string> = new Set(["changed", "origin", "field", "unreachable", "focus", "worker"]);

/** A call to the extension on the conversation's line: a method, its params, and how long its answer may take. */
export type Relay = (method: "cdp.send" | "cdp.batch", params: Record<string, unknown>, timeoutMs: number) => Promise<Record<string, unknown>>;

/** The extension's answer to a method it does not have: one from before batches. */
function unknownMethod(err: unknown): boolean {
  return err instanceof DeviceError && err.code === "bad_request" && /is not something this extension does/.test(err.message);
}

/**
 * A tab's commands, through the extension: one at a time, or several in one
 * round trip, a hundred at most to each. An extension from before batches
 * says it has no such method, and is sent them one by one from then on.
 */
export function relayLine(relay: Relay, tab: string): TabSession {
  const send = (method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> =>
    relay("cdp.send", { tab, method, params: params ?? {} }, (timeoutMs ?? 15_000) + RELAY_SLACK_MS);
  let batches = true;
  const chunk = async (calls: Call[], parallel: boolean, timeoutMs?: number): Promise<(Record<string, unknown> | Error)[]> => {
    const answer = await relay("cdp.batch", { tab, calls: calls.map((c) => ({ method: c.method, params: c.params ?? {} })), parallel }, (timeoutMs ?? 15_000) * Math.max(1, parallel ? 1 : calls.length) + RELAY_SLACK_MS);
    const results = Array.isArray(answer["results"]) ? (answer["results"] as { result?: Record<string, unknown>; error?: { code?: string; message?: string } }[]) : [];
    return calls.map((_, i) => {
      const r = results[i];
      if (!r) return new Error(`not sent: ${results.find((x) => x.error)?.error?.message ?? "the batch was cut short"}`);
      return r.error ? new DeviceError(r.error.code ?? "cdp", r.error.message ?? "the command failed") : (r.result ?? {});
    });
  };
  const batch = async (calls: Call[], parallel: boolean, timeoutMs?: number): Promise<(Record<string, unknown> | Error)[]> => {
    const out: (Record<string, unknown> | Error)[] = [];
    for (let i = 0; i < calls.length; i += BATCH_MAX) {
      const part = calls.slice(i, i + BATCH_MAX);
      // In order, nothing after a command that failed is sent.
      const failed = parallel ? undefined : out.find((r) => r instanceof Error);
      if (failed) {
        out.push(...part.map(() => new Error(`not sent: ${failed.message}`)));
        continue;
      }
      if (!batches) {
        out.push(...(await sendEach(send, part, parallel, timeoutMs)));
        continue;
      }
      try {
        out.push(...(await chunk(part, parallel, timeoutMs)));
      } catch (err) {
        if (!unknownMethod(err)) throw err;
        batches = false;
        out.push(...(await sendEach(send, part, parallel, timeoutMs)));
      }
    }
    return out;
  };
  return { send, batch };
}

/** A JPEG's longer side, from its frame header near the start; 0 when there is none to read. */
export function jpegEdge(base64: string): number {
  const b = Buffer.from(base64.slice(0, 16_384), "base64");
  for (let i = 2; i + 9 < b.length; ) {
    if (b[i] !== 0xff) return 0;
    const marker = b[i + 1]!;
    if (marker >= 0xc0 && marker <= 0xc3) return Math.max(b.readUInt16BE(i + 5), b.readUInt16BE(i + 7));
    i += 2 + b.readUInt16BE(i + 2);
  }
  return 0;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

export class OwnerChrome implements BrowserElsewhere {
  private readonly held = new Map<string, Borrowed>();

  constructor(
    private readonly hub: DeviceHub,
    private readonly secrets?: PageSecrets,
  ) {
    hub.onDeviceEvent((device, event, session) => this.heard(device, event, session));
    hub.onChange(() => {
      // A session gone takes its tabs with it.
      for (const [conversation, b] of this.held) {
        const session = this.hub.sessionOf(conversation);
        if (session?.id !== b.session) this.held.delete(conversation);
        // The owner taking the Chrome over, or handing it back, may have changed any page in it.
        else if (session.paused !== b.paused) {
          b.paused = session.paused;
          b.moved++;
        }
      }
    });
  }

  /** The conversation's live session on a Chrome, if it has one. */
  private session(conversation: string): Session | undefined {
    const session = this.hub.sessionOf(conversation);
    if (!session) return undefined;
    const device = this.hub.find(session.device);
    return device && kindOf(device) === "browser" ? session : undefined;
  }

  active(conversation: string): boolean {
    return this.session(conversation) !== undefined;
  }

  /** The Chrome a conversation is in, by name, for what it is told. */
  deviceOf(conversation: string): Device | undefined {
    const session = this.session(conversation);
    return session ? this.hub.find(session.device) : undefined;
  }

  /** A session just begun: its tabs (the ones the owner handed) learned, and the one beside the side panel made the one it is on. */
  async begun(conversation: string): Promise<Kept[]> {
    const b = this.borrowed(conversation);
    await this.refresh(conversation, b);
    const beside = [...b.tabs].find(([, t]) => t.focus);
    if (beside) b.current = beside[0];
    return [...b.tabs.values()];
  }

  async tab(conversation: string): Promise<Tab> {
    const b = this.borrowed(conversation);
    if (!b.current || !b.tabs.has(b.current)) b.current = await this.open(conversation, b);
    const tab = b.current;
    return { page: this.pageOf(conversation, b, tab), capture: (maxEdge) => this.capture(conversation, tab, maxEdge) };
  }

  tabs(conversation: string): TabInfo[] {
    const b = this.held.get(conversation);
    if (!b) return [];
    return [...b.tabs].map(([id, t]) => ({ id, title: t.title, url: t.url, ...(t.handed ? {} : { mine: true }), ...(id === b.current ? { current: true } : {}) }));
  }

  tabsOf(conversation: string): string[] {
    return [...(this.held.get(conversation)?.tabs.keys() ?? [])];
  }

  async useTab(conversation: string, tab: string): Promise<void> {
    const b = this.borrowed(conversation);
    if (!b.tabs.has(tab)) await this.refresh(conversation, b);
    if (!b.tabs.has(tab)) throw new Error("no such tab in the owner's Chrome; the owner hands one to KOS from the extension");
    b.current = tab;
  }

  async newTab(conversation: string): Promise<string> {
    const b = this.borrowed(conversation);
    b.current = await this.open(conversation, b);
    return b.current;
  }

  spot(conversation: string): PageSpot | undefined {
    const b = this.held.get(conversation);
    return b?.current ? { tab: b.current, url: b.tabs.get(b.current)?.url ?? "", moved: b.moved, session: b.session } : undefined;
  }

  actsAlone(conversation: string, site: string): boolean {
    return this.session(conversation)?.site === site;
  }

  siteOf(conversation: string): string | undefined {
    const b = this.held.get(conversation);
    const url = b?.current ? b.tabs.get(b.current)?.url : undefined;
    return url && url !== "about:blank" ? hostOf(url) : undefined;
  }

  describe(conversation: string): string {
    const device = this.deviceOf(conversation);
    return `the owner's Chrome${device ? ` (${device.name})` : ""}`;
  }

  async picture(conversation: string, maxEdge: number): Promise<string | undefined> {
    const b = this.held.get(conversation);
    return b?.current && this.session(conversation) ? this.capture(conversation, b.current, maxEdge) : undefined;
  }

  private borrowed(conversation: string): Borrowed {
    const session = this.session(conversation);
    if (!session) throw new Error(refusalText(new DeviceError("no_session", "no session"), this.hub.takeEnding(conversation), "browser"));
    let b = this.held.get(conversation);
    if (!b || b.session !== session.id) {
      b = { session: session.id, tabs: new Map(), pages: new Map(), filled: [], moved: 0 };
      this.held.set(conversation, b);
    }
    return b;
  }

  /** A call in the conversation's session; one refused for want of a session says why the last one ended. */
  private async act(conversation: string, method: "tabs.list" | "tabs.open" | "cdp.send" | "cdp.batch" | "secret.fill", params: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
    try {
      return await this.hub.act(conversation, method, params, timeoutMs, turnStop.getStore());
    } catch (err) {
      if (err instanceof DeviceError && err.code === "no_session") throw new DeviceError("no_session", refusalText(err, this.hub.takeEnding(conversation), "browser"));
      throw err;
    }
  }

  private async refresh(conversation: string, b: Borrowed): Promise<void> {
    const listed = await this.act(conversation, "tabs.list", {});
    const tabs = Array.isArray(listed["tabs"]) ? (listed["tabs"] as Record<string, unknown>[]) : [];
    for (const t of tabs) {
      if (typeof t["id"] !== "string") continue;
      b.tabs.set(t["id"], { url: String(t["url"] ?? ""), title: String(t["title"] ?? ""), handed: t["handed"] === true, ...(t["focus"] === true ? { focus: true } : {}) });
    }
  }

  private async open(conversation: string, b: Borrowed): Promise<string> {
    const opened = await this.act(conversation, "tabs.open", { url: "about:blank" });
    const tab = String(opened["tab"] ?? "");
    if (!tab) throw new Error("the owner's Chrome opened no tab");
    b.tabs.set(tab, { url: "about:blank", title: "", handed: false });
    return tab;
  }

  private pageOf(conversation: string, b: Borrowed, tab: string): Page {
    let page = b.pages.get(tab);
    if (!page) {
      const secrets = this.secrets;
      page = new Page(relayLine((method, params, timeoutMs) => this.act(conversation, method, params, timeoutMs), tab), {
        gate: (signal) => this.whileOwnerHas(conversation, signal),
        kin: () => this.kinOf(conversation),
        ...(secrets ? { saved: () => secrets.saved(), savedFor: (origins: readonly string[]) => secrets.savedFor(origins), evalBlocked: (origin: string) => secrets.evalBlocked(origin) } : {}),
        putSecret: (put) => this.putSecret(conversation, tab, put),
      });
      b.pages.set(tab, page);
    }
    return page;
  }

  /** What a conversation's tabs share of the secrets filled in them: every value, and whether any of them holds one now. */
  private kinOf(conversation: string): Kin | undefined {
    const b = this.held.get(conversation);
    return b ? { values: b.filled, holding: () => [...b.pages.values()].some((p) => p.holdsSecret()) } : undefined;
  }

  /**
   * A secret into a field of the tab, by KOS for Chrome itself (secret.fill):
   * the only call that carries a value to it. The extension checks the page,
   * the frame and the field again on its side, puts it in, sees that it
   * holds it without reading it back, and answers that it did, nothing more.
   */
  private async putSecret(conversation: string, tab: string, put: SecretPut): Promise<void> {
    try {
      await this.act(conversation, "secret.fill", { tab, ...put }, SECRET_FILL_MS);
    } catch (err) {
      if (unknownMethod(err)) throw new SecretRefused("unreachable", "this KOS for Chrome is from before it could fill a saved secret; it takes the new build when the owner reloads it");
      if (err instanceof DeviceError && FILL_REFUSALS.has(err.code)) throw new SecretRefused(err.code as SecretRefused["code"], err.message);
      throw err;
    }
  }

  /** Until the owner hands the Chrome back: at once when they have not taken it. True when it waited. */
  private async whileOwnerHas(conversation: string, signal?: AbortSignal): Promise<boolean> {
    if (!this.session(conversation)) return false;
    try {
      return await this.hub.untilHandedBack(conversation, signal);
    } catch (err) {
      if (!(err instanceof DeviceError)) throw err;
      if (err.code === "held") throw new Error("The owner kept control of their Chrome and did not hand it back. Stop here and tell them where you stopped.");
      if (err.code === "stopped_in_control") throw new Error("The owner pressed Stop while they had their Chrome.");
      const why = this.hub.takeEnding(conversation);
      throw new Error(`The session in the owner's Chrome ended while they had it${why ? `: ${endingText(why, "browser")}` : ""}.`);
    }
  }

  /**
   * The tab as it looks, small enough to send, through the extension: one
   * call, the extension making it this size (`maxEdge` is its own, not the
   * protocol's) without drawing the owner's page again. An extension from
   * before that sends it the size of the tab, which is seen by its size, and
   * from then on it is asked to draw the page small, as it was before.
   */
  private async capture(conversation: string, tab: string, maxEdge: number = PICTURE.edge): Promise<string | undefined> {
    const send = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
      this.hub.act(conversation, "cdp.send", { tab, method, params }, 20_000, turnStop.getStore()).catch(() => ({}) as Record<string, unknown>);
    const dataOf = (shot: Record<string, unknown>): string | undefined => (typeof shot["data"] === "string" && shot["data"] ? shot["data"] : undefined);
    const masks = await this.masksFor(conversation, send);
    // A page that may show a secret is masked by the extension, or not pictured at all: one from before secret.picture is not pictured.
    if (masks === null) return undefined;
    if (masks) {
      const shot = await this.hub.act(conversation, "secret.picture", { tab, format: "jpeg", quality: PICTURE.quality, maxEdge, masks }, 20_000, turnStop.getStore()).catch(() => ({}) as Record<string, unknown>);
      return dataOf(shot);
    }
    const b = this.held.get(conversation);
    if (!b?.fullPictures) {
      const data = dataOf(await send("Page.captureScreenshot", { format: "jpeg", quality: PICTURE.quality, maxEdge }));
      if (!data || jpegEdge(data) <= maxEdge) return data;
      if (b) b.fullPictures = true;
    }
    const metrics = await send("Page.getLayoutMetrics");
    const view = (metrics["cssVisualViewport"] ?? metrics["layoutViewport"] ?? {}) as { clientWidth?: number; clientHeight?: number };
    const [width, height] = [view.clientWidth ?? 0, view.clientHeight ?? 0];
    const scale = Math.min(1, maxEdge / Math.max(width, height, 1));
    return dataOf(await send("Page.captureScreenshot", { format: "jpeg", quality: PICTURE.quality, ...(width && height ? { clip: { x: 0, y: 0, width, height, scale } } : {}) }));
  }

  /**
   * The patterns a picture of the tab is masked by, for each origin among
   * its frames: the values filled in the conversation's tabs on that origin
   * and the saved ones for its site, never another's (Page.masked does the
   * same in KOS's own browser). Undefined when there is nothing to mask;
   * null when the frames could not be read, so nothing is pictured.
   */
  private async masksFor(conversation: string, send: (method: string) => Promise<Record<string, unknown>>): Promise<Record<string, string[]> | null | undefined> {
    const filled = this.held.get(conversation)?.filled ?? [];
    const secrets = this.secrets;
    if (!secrets && filled.length === 0) return undefined;
    type FrameTree = { frame?: { securityOrigin?: string }; childFrames?: FrameTree[] };
    const origins = new Set<string>();
    const walk = (t: FrameTree | undefined): void => {
      const origin = t?.frame?.securityOrigin;
      if (origin && /^https?:\/\//.test(origin)) origins.add(origin);
      for (const child of t?.childFrames ?? []) walk(child);
    };
    const tree = (await send("Page.getFrameTree"))["frameTree"] as FrameTree | undefined;
    if (!tree) return filled.length ? null : undefined;
    walk(tree);
    const masks: Record<string, string[]> = {};
    for (const origin of origins) {
      // A value filled is found only on the origins it was filled on: no other frame is sent a pattern it could learn it by.
      const here = filled.filter((v) => !v.origins || v.origins.includes(origin));
      const values = [...here, ...(secrets?.savedFor([origin]) ?? []).filter((v) => !here.some((f) => f.text === v.text))];
      const patterns = echoPatterns(values, 1);
      if (patterns.length) masks[origin] = patterns;
    }
    return Object.keys(masks).length ? masks : undefined;
  }

  /** What the extension tells: a page's events for its hands, tabs closing, tabs handed. */
  private heard(device: string, event: DeviceEvent, session: Session | undefined): void {
    const entry = session ? [...this.held].find(([, b]) => b.session === session.id) : undefined;
    const data = event.data;
    const tab = typeof data["tab"] === "string" ? data["tab"] : undefined;
    if (event.name === "tab.handed") {
      // A tab handed while a session is live joins it at once; the one beside the side panel, where the owner just spoke, is the one KOS is on.
      for (const [conversation, b] of this.held) {
        const live = this.session(conversation);
        if (!tab || live?.id !== b.session || live.device !== device) continue;
        b.tabs.set(tab, { url: String(data["url"] ?? ""), title: String(data["title"] ?? ""), handed: true });
        if (data["focus"] === true) b.current = tab;
      }
      return;
    }
    if (!entry || !tab) return;
    const [, b] = entry;
    if (event.name === "tab.closed") {
      b.tabs.delete(tab);
      b.pages.delete(tab);
      if (b.current === tab) b.current = undefined;
      return;
    }
    if (event.name !== "cdp.event") return;
    const method = String(data["method"] ?? "");
    const params = (typeof data["params"] === "object" && data["params"] !== null ? data["params"] : {}) as Record<string, unknown>;
    if (method === "Page.frameNavigated") {
      const frame = params["frame"] as { parentId?: string; url?: string } | undefined;
      const kept = b.tabs.get(tab);
      if (frame && !frame.parentId && kept && typeof frame.url === "string") {
        kept.url = frame.url;
        b.moved++;
      }
    }
    // A route the page changed to itself; the extension passes on only the main frame's.
    if (method === "Page.navigatedWithinDocument") {
      const kept = b.tabs.get(tab);
      if (kept && typeof params["url"] === "string") {
        kept.url = params["url"];
        b.moved++;
      }
    }
    b.pages.get(tab)?.handle({ method, params });
  }
}
