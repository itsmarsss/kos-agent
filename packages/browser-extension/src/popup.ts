import { parsePairing } from "./address.js";
import type { PopupState } from "./worker.js";

/**
 * The popup under the KOS icon: pairing, and while paired, whether KOS is
 * connected, what it is doing in this Chrome, and the owner's controls:
 * give it this tab or take it back, take over, hand back, stop, unpair.
 */

async function ask<T>(message: Record<string, unknown>): Promise<T> {
  const answer = (await chrome.runtime.sendMessage(message)) as { ok: boolean; value?: T; error?: string };
  if (!answer?.ok) throw new Error(answer?.error ?? "the extension did not answer");
  return answer.value as T;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function minutesLeft(until: number): string {
  const m = Math.max(0, Math.ceil((until - Date.now()) / 60_000));
  return `${m} min left`;
}

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function render(state: PopupState): Promise<void> {
  $("pairing").hidden = state.paired !== null;
  $("paired").hidden = state.paired === null;
  if (!state.paired) return;
  const words: Record<string, string> = { online: "Connected", connecting: "Connecting…", offline: "Offline, trying again", refused: "Not connected" };
  $("status-dot").dataset["state"] = state.link.state;
  $("status").textContent = `${words[state.link.state] ?? state.link.state} to ${new URL(state.paired.url).host}`;
  $("status-detail").textContent = state.link.detail ?? "";
  $("status-detail").hidden = !state.link.detail;
  const session = state.session;
  $("session").hidden = !session;
  if (session) {
    $("task").textContent = session.task;
    $("requester").textContent = `${session.requester} · ${minutesLeft(session.until)}`;
    $("take").textContent = session.paused ? "Hand back" : "Take over";
  }
  const tab = await activeTab();
  const given = tab?.id !== undefined && state.handed.includes(tab.id);
  const web = /^https?:\/\//.test(tab?.url ?? "");
  $("hand").hidden = !web;
  $("hand").textContent = given ? "Take this tab back from KOS" : "Give this tab to KOS";
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
