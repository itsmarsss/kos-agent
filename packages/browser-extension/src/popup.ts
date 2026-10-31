import type { BlobMood } from "@kos/shared/blobmotion";

import { parsePairing } from "./address.js";
import { kosFace } from "./face.js";
import { CHOICES, isHidden, siteOf, type Takeover } from "./settings.js";
import type { KosState, PopupState } from "./worker.js";

/**
 * The popup under the KOS icon, laid out as KOS Device's window is: KOS's
 * face and where it stands; the live session; this tab, to give or take
 * back; each KOS folded to a line, opening to its rules and its line; the
 * sites hidden from KOS; and behind the gear, the owner's settings for this
 * Chrome. It reads the worker's state and asks the worker for every change.
 */

async function ask<T>(message: Record<string, unknown>): Promise<T> {
  const answer = (await chrome.runtime.sendMessage(message)) as { ok: boolean; value?: T; error?: string };
  if (!answer?.ok) throw new Error(answer?.error ?? "the extension did not answer");
  return answer.value as T;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** An element, its attributes and what goes in it: the popup is built from these. */
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean | undefined> = {}, ...kids: (Node | string | false | null | undefined)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === "class") el.className = String(v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids) if (kid !== false && kid !== null && kid !== undefined) el.append(kid);
  return el;
}

function svg(path: string, size = 15): SVGSVGElement {
  const wrap = document.createElement("span");
  wrap.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  return wrap.firstElementChild as SVGSVGElement;
}

const ICON = {
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  hidden: '<path d="M9.9 4.2A10 10 0 0 1 12 4c7 0 10 8 10 8a17 17 0 0 1-3.2 4.5M6.6 6.6A17 17 0 0 0 2 12s3 8 10 8a10 10 0 0 0 5.4-1.6"/><path d="M3 3l18 18M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  back: '<path d="m15 6-6 6 6 6"/>',
  hand: '<path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8a8 8 0 0 0 16 0v-3a2 2 0 0 0-4 0"/>',
};

/** Each line state, in a word and a tone, as the app's pills say them. */
const LINK: Record<string, { word: string; tone: string }> = {
  online: { word: "Connected", tone: "ok" },
  connecting: { word: "Connecting", tone: "accent" },
  offline: { word: "Offline", tone: "warn" },
  refused: { word: "Not connected", tone: "danger" },
};
const linkOf = (k: KosState): { word: string; tone: string } => (k.held ? { word: "Disconnected", tone: "muted" } : LINK[k.link] ?? { word: k.link, tone: "muted" });

const minutesWords = (m: number): string => (m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60}` : `${m / 60} h`);

function minutesLeft(until: number): string {
  const m = Math.max(0, Math.ceil((until - Date.now()) / 60_000));
  return m <= 1 ? "under a minute left" : `${minutesWords(m)} left`;
}

// What only the popup holds: which page, which KOS is open, which drawers.
const view = {
  page: "home" as "home" | "settings",
  openKos: undefined as string | undefined,
  hiddenOpen: false,
  adding: false,
  unpairArmed: undefined as string | undefined,
  /** The KOS whose Ask before each session is being turned off: asked once, in the card. */
  confirmAsk: undefined as string | undefined,
};
let state: PopupState | undefined;
let tab: chrome.tabs.Tab | undefined;
const face = kosFace(36, "idle");
$("face").append(face.el);

function mood(s: PopupState): BlobMood {
  if (s.session) return s.session.paused ? "idle" : "working";
  if (!s.kos.length) return "idle";
  if (s.kos.some((k) => k.link === "online" && !k.held)) return "idle";
  if (s.kos.every((k) => k.held)) return "asleep";
  return "error";
}

function render(): void {
  if (!state) return;
  const s = state;
  face.setMood(mood(s));
  const live = s.session && !s.session.paused;
  const best = s.kos.find((k) => k.link === "online" && !k.held) ?? s.kos[0];
  $("pill").textContent = !s.kos.length ? "Not paired" : live ? "In use" : best && linkOf(best).word === "Connected" ? "Ready" : best ? linkOf(best).word : "Not paired";
  $("pill").dataset["tone"] = !s.kos.length ? "muted" : live ? "accent" : best ? linkOf(best).tone : "muted";
  $("gear").hidden = view.page !== "home";
  $("home").hidden = view.page !== "home";
  $("settings").hidden = view.page !== "settings";
  if (view.page === "home") $("home").replaceChildren(...home(s));
  else $("settings").replaceChildren(...settingsPage(s));
}

// The home page.

function home(s: PopupState): Node[] {
  const out: Node[] = [];
  if (s.session) out.push(sessionCard(s.session));
  if (s.kos.length) {
    const t = thisTab(s);
    if (t) out.push(t);
  }
  out.push(kosSection(s));
  out.push(hiddenSection(s));
  out.push(h("p", { class: "foot" }, svg(ICON.hand, 13), h("span", {}, "KOS works only in its own window and the tabs you give it. Click or type in one of them and it pauses.")));
  return out;
}

function sessionCard(session: NonNullable<PopupState["session"]>): Node {
  const take = h("button", { type: "button", class: "btn" }, session.paused ? "Hand back" : "Take over");
  take.addEventListener("click", () => void act({ type: session.paused ? "handback" : "take" }));
  const stop = h("button", { type: "button", class: "btn btn--danger" }, "Stop");
  stop.addEventListener("click", () => void act({ type: "stop" }));
  return h(
    "section",
    { class: "card live", "data-paused": session.paused },
    h("div", { class: "live-head" }, h("strong", {}, session.paused ? "Paused. You have control." : "KOS is using this Chrome"), h("span", { class: "hint" }, minutesLeft(session.until))),
    h("p", { class: "quote" }, session.task),
    h("p", { class: "hint" }, "Asked from ", h("strong", {}, session.requester), session.kos ? ` on ${session.kos}` : ""),
    h("div", { class: "row" }, take, stop),
  );
}

function thisTab(s: PopupState): Node | undefined {
  const url = tab?.url ?? "";
  if (!tab || !/^https?:\/\//.test(url)) return undefined;
  const host = new URL(url).host;
  const hidden = isHidden(url, s.settings.hiddenSites);
  const given = tab.id !== undefined && s.handed.includes(tab.id);
  const icon = tab.favIconUrl ? h("img", { src: tab.favIconUrl, alt: "" }) : svg(ICON.globe);
  let button: HTMLButtonElement;
  if (hidden) {
    button = h("button", { type: "button", class: "btn btn--wide" }, "Show this site to KOS");
    const site = s.settings.hiddenSites.find((x) => isHidden(url, [x]));
    button.addEventListener("click", () => void act({ type: "unhide", site }));
  } else {
    button = h("button", { type: "button", class: given ? "btn btn--wide" : "btn btn--wide btn--primary" }, given ? "Take this tab back" : "Give this tab to KOS");
    button.addEventListener("click", () => void act({ type: "hand", tab: tab!.id, give: !given }));
  }
  return h(
    "section",
    { class: "section" },
    h("p", { class: "label" }, "This tab"),
    h(
      "div",
      { class: "card" },
      h("div", { class: "line" }, h("span", { class: "tile" }, icon), h("div", { class: "line-text" }, h("strong", {}, tab.title || host), h("span", {}, hidden ? `${host} · hidden from KOS` : given ? `${host} · KOS can work here` : host))),
      button,
    ),
  );
}

function kosSection(s: PopupState): Node {
  const head = h("div", { class: "section-head" }, h("p", { class: "label" }, s.kos.length > 1 ? `KOS · ${s.kos.length}` : "KOS"));
  if (s.kos.length && !view.adding) {
    const add = h("button", { type: "button", class: "btn btn--ghost btn--sm" }, "+ Add a KOS");
    add.title = "Pair this Chrome with another KOS as well, say one at work beside one at home.";
    add.addEventListener("click", () => {
      view.adding = true;
      render();
      document.getElementById("link")?.focus();
    });
    head.append(add);
  }
  const section = h("section", { class: "section" }, head);
  for (const k of s.kos) section.append(kosCard(k));
  if (!s.kos.length || view.adding) section.append(pairCard(s));
  return section;
}

function kosCard(k: KosState): Node {
  const open = view.openKos === k.id;
  const link = linkOf(k);
  const summary = k.link === "online" && !k.held ? `As ${k.name} · ${k.askFirst ? "asks here first" : "its approvals decide"}` : k.held ? "Not connected. The pairing stays." : k.detail ?? `${link.word}.`;
  const row = drawerRow(svg(ICON.server), k.link === "online" && !k.held ? "ok" : link.tone, k.host, summary, open, () => {
    view.openKos = open ? undefined : k.id;
    render();
  }, k.link === "online" && !k.held ? undefined : h("span", { class: "pill", "data-tone": link.tone }, link.word));
  const card = h("div", { class: "card" }, row);
  if (!open) return card;

  const askSwitch = toggle(k.askFirst, (on) => {
    if (on) return void act({ type: "askFirst", id: k.id, on: true });
    view.confirmAsk = k.id;
    render();
  });
  const connect = k.held
    ? h("button", { type: "button", class: "btn btn--primary" }, "Connect")
    : h("button", { type: "button", class: "btn btn--ghost" }, "Disconnect");
  connect.addEventListener("click", () => void act({ type: k.held ? "connect" : "disconnect", id: k.id }));
  const armed = view.unpairArmed === k.id;
  const unpair = h("button", { type: "button", class: "btn btn--danger" }, armed ? "Press again" : "Unpair");
  unpair.title = "This KOS forgets this Chrome too. Any other KOS stays paired.";
  unpair.addEventListener("click", () => {
    if (!armed) {
      view.unpairArmed = k.id;
      render();
      setTimeout(() => {
        if (view.unpairArmed !== k.id) return;
        view.unpairArmed = undefined;
        render();
      }, 3_000);
      return;
    }
    view.unpairArmed = undefined;
    view.openKos = undefined;
    void act({ type: "unpair", id: k.id });
  });
  const retry = !k.held && (k.link === "offline" || k.link === "refused") ? h("button", { type: "button", class: "btn" }, "Reconnect") : undefined;
  retry?.addEventListener("click", () => void act({ type: "connect", id: k.id }));
  card.append(
    h("hr", { class: "rule" }),
    h(
      "div",
      { class: "setting" },
      h("div", { class: "setting-text" }, h("strong", {}, "Ask before each session"), h("span", {}, k.askFirst ? "This KOS asks here, with the task and how long, every time." : "Off: this KOS's approval queue decides instead. The border and Stop still show.")),
      askSwitch,
    ),
    // Two rows: a popup is narrower than KOS Device's window, and one row cut its first button off.
    h("div", { class: "row row--start" }, connect, retry),
    h("div", { class: "row" }, h("a", { class: "link grow", href: k.url, target: "_blank", rel: "noopener" }, "Dashboard"), unpair),
  );
  if (view.confirmAsk === k.id) {
    const keep = h("button", { type: "button", class: "btn btn--ghost" }, "Keep asking");
    keep.addEventListener("click", () => {
      view.confirmAsk = undefined;
      render();
    });
    const stopAsking = h("button", { type: "button", class: "btn btn--primary" }, "Stop asking here");
    stopAsking.addEventListener("click", () => {
      view.confirmAsk = undefined;
      void act({ type: "askFirst", id: k.id, on: false });
    });
    card.append(h("div", { class: "confirm" }, h("p", { class: "hint" }, `Let ${k.host} start sessions in this Chrome without asking here? Its approval queue decides instead, for when you are away; the border and Stop still show.`), h("div", { class: "row" }, keep, stopAsking)));
  }
  return card;
}

function pairCard(s: PopupState): Node {
  const link = h("input", { id: "link", class: "mono", type: "text", placeholder: "kos-device://pair?url=…&code=…", spellcheck: "false", autocomplete: "off", required: true });
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? "";
  const name = h("input", { id: "name", type: "text", placeholder: "Chrome on macOS", spellcheck: "false" });
  name.value = `Chrome${platform ? ` on ${platform}` : ""}`;
  const pair = h("button", { type: "submit", class: "btn btn--primary" }, "Pair");
  const cancel = s.kos.length ? h("button", { type: "button", class: "btn btn--ghost" }, "Cancel") : undefined;
  cancel?.addEventListener("click", () => {
    view.adding = false;
    render();
  });
  const form = h(
    "form",
    { class: "card" },
    h("strong", {}, s.kos.length ? "Pair with another KOS" : "Pair with your KOS"),
    h("p", { class: "hint" }, s.kos.length ? "From that KOS: Settings, Devices, Add a device. Pairing one already here replaces it." : "In KOS: Settings, Devices, Add a device. Paste its link here."),
    h("label", { class: "field" }, h("span", {}, "Pairing link"), link),
    h("label", { class: "field" }, h("span", {}, "This Chrome's name in KOS"), name),
    h("div", { class: "row" }, cancel, pair),
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void (async () => {
      hideError();
      try {
        parsePairing(link.value);
        pair.disabled = true;
        await act({ type: "pair", link: link.value, name: name.value.trim() });
        view.adding = false;
        render();
      } catch (err) {
        show(err);
      } finally {
        pair.disabled = false;
      }
    })();
  });
  return form;
}

function hiddenSection(s: PopupState): Node {
  const sites = s.settings.hiddenSites;
  const summary = view.hiddenOpen
    ? "Never opened, acted on or reported to KOS, with every subdomain."
    : !sites.length
      ? "Nothing yet. Add a site and KOS never sees it."
      : sites.length <= 2
        ? sites.join(" and ")
        : `${sites[0]}, ${sites[1]} and ${sites.length - 2} more`;
  const row = drawerRow(svg(ICON.hidden), "accent", "Hidden from KOS", summary, view.hiddenOpen, () => {
    view.hiddenOpen = !view.hiddenOpen;
    render();
  });
  const card = h("div", { class: "card" }, row);
  if (view.hiddenOpen) {
    const chips = h("div", { class: "site-chips" });
    for (const site of sites) {
      const x = h("button", { type: "button", "aria-label": `Show ${site} to KOS`, title: `Show ${site} to KOS` }, "×");
      x.addEventListener("click", () => void act({ type: "unhide", site }));
      chips.append(h("span", { class: "site-chip" }, site, x));
    }
    const input = h("input", { type: "text", placeholder: "example.com", spellcheck: "false", autocomplete: "off", "aria-label": "A site to hide" });
    const add = h("button", { type: "submit", class: "btn" }, "Hide");
    const form = h("form", { class: "add-site" }, input, add);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void act({ type: "hide", site: input.value });
    });
    card.append(h("hr", { class: "rule" }), chips, form);
    const here = tab?.url && /^https?:\/\//.test(tab.url) && !isHidden(tab.url, sites) ? siteOf(tab.url) : undefined;
    if (here) {
      const quick = h("button", { type: "button", class: "btn btn--ghost btn--sm" }, `Hide ${here}`);
      quick.addEventListener("click", () => void act({ type: "hide", site: here }));
      card.append(h("div", { class: "row" }, quick));
    }
  }
  return h("section", { class: "section" }, h("p", { class: "label" }, "On this Chrome"), card);
}

// The settings page.

function settingsPage(s: PopupState): Node[] {
  const back = h("button", { type: "button", class: "icon-btn", "aria-label": "Back", title: "Back" }, svg(ICON.back, 14));
  back.addEventListener("click", () => {
    view.page = "home";
    render();
  });
  const set = (patch: Record<string, unknown>): void => void act({ type: "settings", patch });
  const takeover: [Takeover, string][] = [
    ["anyInput", "Clicks, keys, scrolling"],
    ["clicksAndKeys", "Clicks and keys"],
  ];
  return [
    h("div", { class: "page-head" }, back, h("strong", {}, "Settings")),
    section(
      "Sessions",
      setting("Longest session", "KOS may ask for longer; it gets this at most.", chips(CHOICES.longestMinutes.map((m) => [m, minutesWords(m)]), s.settings.longestMinutes, (m) => set({ longestMinutes: m }))),
      setting("Wait for an answer", "Then the ask says no by itself, so a Chrome nobody is at says no.", chips(CHOICES.promptWaitSeconds.map((x) => [x, x < 60 ? `${x} s` : minutesWords(x / 60)]), s.settings.promptWaitSeconds, (x) => set({ promptWaitSeconds: x }))),
      setting("End when idle for", "A session KOS has stopped using gives Chrome back on its own.", chips(CHOICES.idleMinutes.map((m) => [m, minutesWords(m)]), s.settings.idleMinutes, (m) => set({ idleMinutes: m }))),
    ),
    section(
      "While KOS works",
      setting(
        "What pauses KOS",
        s.settings.takeover === "anyInput" ? "Your click, key or scroll in a KOS tab pauses it at once." : "Only a click or a key; you can scroll a KOS tab freely.",
        chips(takeover, s.settings.takeover, (t) => set({ takeover: t })),
      ),
    ),
    section(
      "App",
      toggleSetting("Connect when Chrome opens", s.settings.connectOnStart ? "Each KOS can reach this Chrome as soon as it opens." : "Off: each waits for Connect, so KOS cannot reach this Chrome until you say.", s.settings.connectOnStart, (on) => set({ connectOnStart: on })),
      toggleSetting("Time left on the KOS icon", s.settings.timeOnIcon ? "The icon counts down while a session runs." : "Off: the icon says ON while a session runs.", s.settings.timeOnIcon, (on) => set({ timeOnIcon: on })),
    ),
    section("Diagnostics", logRow()),
  ];
}

function section(title: string, ...rows: Node[]): Node {
  const card = h("div", { class: "card" });
  rows.forEach((row, i) => {
    if (i) card.append(h("hr", { class: "rule" }));
    card.append(row);
  });
  return h("section", { class: "section" }, h("p", { class: "label" }, title), card);
}

function setting(title: string, detail: string, control: Node): Node {
  return h("div", { class: "setting setting--stacked" }, h("div", { class: "setting-text" }, h("strong", {}, title), h("span", {}, detail)), control);
}

function toggleSetting(title: string, detail: string, on: boolean, set: (on: boolean) => void): Node {
  return h("div", { class: "setting" }, h("div", { class: "setting-text" }, h("strong", {}, title), h("span", {}, detail)), toggle(on, set));
}

function logRow(): Node {
  const copy = h("button", { type: "button", class: "btn" }, "Copy log");
  copy.addEventListener("click", () => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(await ask<string>({ type: "log" }));
        copy.textContent = "Copied";
        setTimeout(() => (copy.textContent = "Copy log"), 2_000);
      } catch (err) {
        show(err);
      }
    })();
  });
  return h("div", { class: "setting" }, h("div", { class: "setting-text" }, h("strong", {}, "Log"), h("span", {}, "Each KOS's line and every session, since Chrome opened. Tasks are kept out. Copy it to send when something went wrong.")), copy);
}

// The pieces the pages are made of.

function chips<V extends string | number>(options: [V, string][], selected: V, choose: (v: V) => void): Node {
  const row = h("div", { class: "chips" });
  for (const [value, label] of options) {
    const b = h("button", { type: "button", "aria-pressed": String(value === selected) }, label);
    b.addEventListener("click", () => choose(value));
    row.append(b);
  }
  return row;
}

function toggle(on: boolean, set: (on: boolean) => void): Node {
  const b = h("button", { type: "button", class: "switch", role: "switch", "aria-checked": String(on) }, h("span", {}));
  b.addEventListener("click", () => set(!on));
  return b;
}

/** A row that opens what is under it: an icon on its tint, a title, a line of detail, what it carries on the right, a chevron. */
function drawerRow(icon: Node, tone: string, title: string, detail: string, open: boolean, toggleOpen: () => void, trailing?: Node): Node {
  const b = h(
    "button",
    { type: "button", class: "drawer", "aria-expanded": String(open) },
    h("span", { class: "tile", "data-tone": tone }, icon),
    h("span", { class: "line-text" }, h("strong", {}, title), h("span", {}, detail)),
    trailing,
    h("span", { class: "chev" }, svg(ICON.chevron, 12)),
  );
  b.addEventListener("click", toggleOpen);
  return b;
}

// Talking to the worker.

function show(error: unknown): void {
  $("error").textContent = error instanceof Error ? error.message : String(error);
  $("error").hidden = false;
}

function hideError(): void {
  $("error").hidden = true;
}

async function act(message: Record<string, unknown>): Promise<void> {
  hideError();
  try {
    state = await ask<PopupState>(message);
    render();
  } catch (err) {
    show(err);
  }
}

let shown = "";
/** The worker's state and the tab in front, drawn again only when something changed, so a click never lands on a row being replaced. */
async function refresh(): Promise<void> {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state = await ask<PopupState>({ type: "state" });
  const key = JSON.stringify([state, tab?.id, tab?.url, tab?.title, tab?.favIconUrl, state.session && minutesLeft(state.session.until)]);
  if (key === shown) return;
  shown = key;
  render();
}

$("gear").addEventListener("click", () => {
  view.page = "settings";
  render();
});
void refresh().catch(show);
// Kept current while open; not while typing, so a field keeps what is in it.
setInterval(() => {
  if (document.activeElement instanceof HTMLInputElement) return;
  void refresh().catch(() => undefined);
}, 2_000);
