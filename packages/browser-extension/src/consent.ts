import { kosFace } from "./face.js";
import type { ConsentRequest } from "./worker.js";

/**
 * The window the extension opens when KOS asks to work in this Chrome:
 * what for, which chat asks (and which KOS, when there are several), and
 * for how long, up to the owner's longest, with Allow and Deny. Closing it,
 * or leaving it the owner's wait, is Deny, and it counts that wait down.
 */

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const CHOICES = [5, 15, 30, 60, 120, 240, 480];

const id = new URLSearchParams(location.search).get("id") ?? "";
let minutes = 15;

function choose(m: number): void {
  minutes = m;
  for (const b of document.querySelectorAll<HTMLButtonElement>("#minutes button")) b.setAttribute("aria-pressed", String(Number(b.dataset["m"]) === m));
}

async function decide(allowed: boolean): Promise<void> {
  await chrome.runtime.sendMessage({ type: "consent.answer", id, allowed, minutes });
  window.close();
}

function countDown(waitMs: number): void {
  const opened = Date.now();
  const tick = (): void => {
    const left = Math.max(0, Math.ceil((waitMs - (Date.now() - opened)) / 1000));
    $("count").textContent = `Says no in ${left} s`;
  };
  tick();
  setInterval(tick, 1000);
}

$("halo").append(kosFace(54, "needs-you").el);

void (async () => {
  const answer = (await chrome.runtime.sendMessage({ type: "consent.request", id })) as { ok: boolean; value: ConsentRequest | null };
  const request = answer?.value;
  if (!request) {
    $("task").textContent = "This ask has lapsed.";
    $("allow").hidden = true;
    $("deny").textContent = "Close";
    $("deny").addEventListener("click", () => window.close());
    return;
  }
  $("task").textContent = request.task;
  $("requester").textContent = request.requester;
  if (request.kos) $("kos").textContent = ` on ${request.kos}`;
  const choices = [...new Set([...CHOICES.filter((m) => m <= Math.min(request.longest, Math.max(request.minutes, 5))), request.minutes])].sort((a, b) => a - b);
  for (const m of choices) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset["m"] = String(m);
    b.textContent = m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60}` : `${m / 60} h`;
    b.addEventListener("click", () => choose(m));
    $("minutes").appendChild(b);
  }
  choose(request.minutes);
  $("allow").addEventListener("click", () => void decide(true));
  $("deny").addEventListener("click", () => void decide(false));
  $("allow").focus();
  countDown(request.waitMs);
})();
