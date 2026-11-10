// KOS for Chrome, driven as its owner would: the real extension loaded into the run's headless
// Chrome with reading granted, paired with the scratch KOS, its side panel open beside a tab.

import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function chromePanel({ chrome, kos, extDist, workDir, tabUrl }) {
  const ext = join(workDir, "ext");
  cpSync(extDist, ext, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
  // Headless Chrome cannot press Allow on page reading, so the grant is made up front.
  manifest.host_permissions = ["<all_urls>"];
  writeFileSync(join(ext, "manifest.json"), JSON.stringify(manifest, null, 2));
  const { id } = await chrome.send("Extensions.loadUnpacked", { path: ext });
  const popup = await chrome.open(`chrome-extension://${id}/popup.html`);
  await sleep(900);
  const { code } = await kos.api("/api/devices/pairings", {});
  const link = `kos-device://pair?url=${encodeURIComponent(kos.url)}&code=${code}`;
  await chrome.evaluate(popup.session, `chrome.runtime.sendMessage({ type: "pair", link: ${JSON.stringify(link)}, name: "Eval Chrome" })`);
  await sleep(1500);
  const tab = await chrome.open(tabUrl);
  await sleep(1500);
  const marker = new URL(tabUrl).pathname;
  await chrome.send("Runtime.evaluate", { expression: `(async () => { const all = await chrome.windows.getAll({ populate: true }); const w = all.find((x) => x.tabs.some((t) => (t.url || "").includes(${JSON.stringify(marker)}))); await chrome.sidePanel.open({ windowId: w.id }); })()`, awaitPromise: true, userGesture: true }, popup.session);
  let panel;
  for (let i = 0; i < 100 && !panel; i++) {
    const { targetInfos } = await chrome.send("Target.getTargets");
    const t = targetInfos.find((x) => x.url.endsWith("/panel.html"));
    if (t) panel = (await chrome.send("Target.attachToTarget", { targetId: t.targetId, flatten: true })).sessionId;
    else await sleep(100);
  }
  if (!panel) throw new Error("the side panel did not open");
  const q = (expr) => chrome.evaluate(panel, expr);
  await sleep(4000);
  // A chat of its own, with Auto on: the owner lets this chat act in their Chrome without asking each step.
  await q("document.querySelector('.chat-title')?.click()");
  await sleep(600);
  await q("document.querySelector('.switcher-new')?.click()");
  await sleep(3500);
  if ((await q("document.querySelector('.mode')?.getAttribute('aria-pressed')")) !== "true") await q("document.querySelector('.mode')?.click()");
  await sleep(1000);
  const cards = [];
  // The panel's chat, as KOS keeps it: the newest chat on the Chrome surface, just made by New chat.
  const chrome_ = (await kos.conversations()).filter((x) => x.channel === "chrome").sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
  const chat = chrome_?.id;
  if (chat) kos.mine.add(chat);

  /** Says something in the panel, consents to the session it asks for, and waits for the answer in KOS's transcript. */
  const say = async (text, { limitMs = 600_000 } = {}) => {
    const before = chat ? (await kos.replies(chat)).length : 0;
    const t0 = Date.now();
    await q(`(() => { const ta = document.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, ${JSON.stringify(text)}); ta.dispatchEvent(new Event('input', { bubbles: true })); setTimeout(() => document.querySelector('.send').click(), 50); })()`);
    let idle = 0;
    let timedOut = true;
    let answer = "";
    while (Date.now() - t0 < limitMs) {
      // Starting a session in this Chrome is the owner's to allow, on the device: allowed, and noted.
      const consent = await q("document.querySelector('.ask-card--consent')?.innerText ?? ''");
      if (consent) {
        cards.push({ kind: "consent", text: consent.slice(0, 300), at: Date.now() });
        await q("document.querySelector('.ask-card--consent .btn--primary')?.click()");
      }
      // Approvals of risky steps go through the dashboard's queue, by the run's policy.
      await kos.decide();
      const list = await kos.conversations();
      const c = list.find((x) => x.id === chat);
      const now = chat ? await kos.replies(chat) : [];
      // A decision resumes the turn: its answer, not the wait before it, is the one to judge.
      if ((await kos.resumed(list)) && now.length > before && c?.activity !== "working") {
        if (++idle >= 3) {
          answer = now.slice(before).join("\n\n");
          timedOut = false;
          break;
        }
      } else idle = 0;
      await sleep(600);
    }
    await kos.settle(t0 + limitMs);
    return { chat, t0, t1: Date.now(), wall: (Date.now() - t0) / 1000, answer, timedOut };
  };
  return { say, cards, tab, q };
}
