import { parsePairing } from "./address.js";
import type { PopupState } from "./worker.js";

/**
 * The popup under the KOS icon: pairing, and while paired, where the line to
 * KOS stands, what KOS is doing in this Chrome, and the owner's controls:
 * give it this tab or take it back, take over, hand back, stop, unpair.
 */

async function ask<T>(message: Record<string, unknown>): Promise<T> {
  const answer = (await chrome.runtime.sendMessage(message)) as { ok: boolean; value?: T; error?: string };
  if (!answer?.ok) throw new Error(answer?.error ?? "the extension did not answer");
  return answer.value as T;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** Each line state, in a word and a tone, as the app's pills say them. */
const LINK: Record<string, { word: string; tone: string }> = {
  online: { word: "Connected", tone: "ok" },
  connecting: { word: "Connecting", tone: "accent" },
  offline: { word: "Offline", tone: "warn" },
  refused: { word: "Not connected", tone: "danger" },
};

function minutesLeft(until: number): string {
  const m = Math.max(0, Math.ceil((until - Date.now()) / 60_000));
  return m <= 1 ? "under a minute left" : m < 60 ? `${m} min left` : `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} ` : ""}left`;
}

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function render(state: PopupState): Promise<void> {
  const paired = state.paired;
  $("pairing").hidden = paired !== null;
  $("paired").hidden = paired === null;
  const link = LINK[state.link.state] ?? { word: state.link.state, tone: "muted" };
  $("pill").textContent = paired ? (state.session && !state.session.paused ? "In use" : link.word) : "Not paired";
  $("pill").dataset["tone"] = paired ? (state.session && !state.session.paused ? "accent" : link.tone) : "muted";

  const session = state.session;
  $("session").hidden = !session;
  if (session) {
    $("session").toggleAttribute("data-paused", session.paused);
    $("live-title").textContent = session.paused ? "Paused. You have control." : "KOS is using this Chrome";
    $("left").textContent = minutesLeft(session.until);
    $("task").textContent = session.task;
    $("requester").textContent = session.requester;
    $("take").textContent = session.paused ? "Hand back" : "Take over";
  }
  if (!paired) {
    $("this-tab").hidden = true;
    return;
  }

  const host = new URL(paired.url);
  $("host").textContent = host.host;
  $("as").textContent = `As ${paired.name}`;
  $("kos-tile").dataset["tone"] = link.tone;
  $<HTMLAnchorElement>("dashboard").href = paired.url;
  $("status-detail").textContent = state.link.detail ?? "";
  $("status-detail").hidden = !state.link.detail;

  // The tab in front, and whether it is KOS's: only a web page can be given.
  const tab = await activeTab();
  const web = /^https?:\/\//.test(tab?.url ?? "");
  $("this-tab").hidden = !web;
  if (!web || !tab) return;
  const given = tab.id !== undefined && state.handed.includes(tab.id);
  $("tab-title").textContent = tab.title || new URL(tab.url!).host;
  $("tab-host").textContent = given ? `${new URL(tab.url!).host} · KOS can work here` : new URL(tab.url!).host;
  const icon = $<HTMLImageElement>("tab-icon");
  icon.hidden = !tab.favIconUrl;
  $("tab-glyph").toggleAttribute("hidden", Boolean(tab.favIconUrl));
  if (tab.favIconUrl && icon.src !== tab.favIconUrl) icon.src = tab.favIconUrl;
  $("hand").textContent = given ? "Take this tab back" : "Give this tab to KOS";
  $("hand").className = given ? "btn btn--wide" : "btn btn--wide btn--primary";
  $("hand").dataset["give"] = given ? "" : "1";
}

async function refresh(): Promise<void> {
  await render(await ask<PopupState>({ type: "state" }));
}

function show(error: unknown): void {
  $("error").textContent = error instanceof Error ? error.message : String(error);
  $("error").hidden = false;
}

async function act(message: Record<string, unknown>): Promise<void> {
  $("error").hidden = true;
  try {
    await render(await ask<PopupState>(message));
  } catch (err) {
    show(err);
  }
}

$("pair-form").addEventListener("submit", (e) => {
  e.preventDefault();
  void (async () => {
    $("error").hidden = true;
    try {
      const text = $<HTMLInputElement>("link").value;
      parsePairing(text);
      $<HTMLButtonElement>("pair").disabled = true;
      await act({ type: "pair", link: text, name: $<HTMLInputElement>("name").value.trim() });
    } catch (err) {
      show(err);
    } finally {
      $<HTMLButtonElement>("pair").disabled = false;
    }
  })();
});

$("hand").addEventListener("click", () => {
  void (async () => {
    const tab = await activeTab();
    if (tab?.id !== undefined) await act({ type: "hand", tab: tab.id, give: $("hand").dataset["give"] === "1" });
  })();
});
$("take").addEventListener("click", () => void act({ type: $("take").textContent === "Hand back" ? "handback" : "take" }));
$("stop").addEventListener("click", () => void act({ type: "stop" }));

// Unpairing asks twice: the second press within a few seconds does it.
let unpairArmed: ReturnType<typeof setTimeout> | undefined;
$("unpair").addEventListener("click", () => {
  if (unpairArmed === undefined) {
    $("unpair").textContent = "Press again to unpair";
    unpairArmed = setTimeout(() => {
      unpairArmed = undefined;
      $("unpair").textContent = "Unpair";
    }, 3_000);
    return;
  }
  clearTimeout(unpairArmed);
  unpairArmed = undefined;
  $("unpair").textContent = "Unpair";
  void act({ type: "unpair" });
});

const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? "";
$<HTMLInputElement>("name").value = `Chrome${platform ? ` on ${platform}` : ""}`;
void refresh().catch(show);
setInterval(() => void refresh().catch(() => undefined), 2_000);
