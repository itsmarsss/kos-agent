/**
 * What the owner sees on a tab KOS is using: a glowing border, and a small
 * bar saying what KOS is doing, with Take over and Stop. The same pieces as
 * KOS Device puts over a Mac: the border sweeping blue into violet, amber and
 * still while the owner has it; the bar with KOS's face, two lines and the
 * app's own buttons.
 *
 * Put in the page over the debugging connection, into a world of its own
 * (the page's scripts cannot reach it), so the extension needs no
 * permission to read the owner's sites. Hidden from the accessibility tree,
 * so KOS's own reading of the page does not take it for the page. It also
 * reports the owner's clicks and keys, for the extension to tell from
 * KOS's own. It runs in the page, so it stands alone: nothing from outside.
 */

export interface OverlayState {
  task: string;
  paused: boolean;
  /** When the session ends, epoch ms. */
  until: number;
}

export function installOverlay(): void {
  const w = window as unknown as { __kos?: { set(state: OverlayState): void; remove(): void }; kosOverlay?: (payload: string) => void };
  if (w.__kos) return;
  const tell = (message: Record<string, unknown>): void => {
    try {
      w.kosOverlay?.(JSON.stringify(message));
    } catch {
      /* the extension is gone; nothing to tell */
    }
  };
  let state: OverlayState = { task: "", paused: false, until: 0 };
  let host: HTMLElement | null = null;
  let title: HTMLElement | null = null;
  let text: HTMLElement | null = null;
  let left: HTMLElement | null = null;
  let take: HTMLButtonElement | null = null;
  let removed = false;

  const minutes = (): string => {
    const m = Math.max(0, Math.ceil((state.until - Date.now()) / 60_000));
    if (!state.until) return "";
    return m <= 1 ? " · under a minute left" : ` · ${m} min left`;
  };
  const render = (): void => {
    if (!host || !title || !text || !take || !left) return;
    host.dataset["paused"] = state.paused ? "1" : "";
    title.textContent = state.paused ? "Paused. You have this tab." : "KOS is using this tab";
    text.textContent = state.task || "working";
    left.textContent = minutes();
    take.textContent = state.paused ? "Hand back" : "Take over";
    take.dataset["act"] = state.paused ? "handback" : "take";
  };

  const build = (): void => {
    if (removed || host || !document.documentElement) return;
    host = document.createElement("kos-overlay");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;";
    const shadow = host.attachShadow({ mode: "closed" });
    // KOS's face as @kos/shared colours it, written in rather than imported,
    // since this function runs in the page on its own; extension.test.ts keeps them in step.
    const face = { fill: "#3585ed", ink: "#141d29" };
    shadow.innerHTML = `<style>
      :host { --accent: #7c9cff; --violet: #a57cff; --warn: #e6b84d; --danger: #f07178; --tone: var(--accent); }
      :host([data-paused="1"]) { --tone: var(--warn); }
      .glow { position: fixed; inset: 0; pointer-events: none; border-radius: 6px;
        box-shadow: inset 0 0 0 2px var(--accent), inset 0 0 24px 4px rgba(124, 156, 255, 0.4);
        animation: sweep 3.2s ease-in-out infinite; }
      :host([data-paused="1"]) .glow { box-shadow: inset 0 0 0 2px var(--warn), inset 0 0 18px 2px rgba(230, 184, 77, 0.35); animation: none; }
      @keyframes sweep { 50% { box-shadow: inset 0 0 0 2px var(--violet), inset 0 0 28px 6px rgba(165, 124, 255, 0.42); } }
      .bar { position: fixed; right: 14px; bottom: 14px; pointer-events: auto; display: flex; align-items: center; gap: 12px;
        max-width: min(480px, calc(100vw - 28px)); height: 48px; padding: 0 8px 0 12px; border-radius: 999px;
        background: rgba(18, 21, 28, 0.96); color: #e7ebf3; font: 12.5px/1.25 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
        -webkit-font-smoothing: antialiased;
        border: 1px solid color-mix(in srgb, var(--tone) 55%, transparent);
        box-shadow: 0 0 12px color-mix(in srgb, var(--tone) 35%, transparent), 0 8px 24px rgba(0, 0, 0, 0.35); }
      .face { position: relative; flex: none; width: 26px; height: 26px; border-radius: 50% 50% 47% 53% / 52% 50% 50% 48%; background: ${face.fill};
        display: flex; align-items: center; justify-content: center; gap: 5px; }
      .face i { width: 3px; height: 6px; border-radius: 2px; background: ${face.ink}; margin-top: -2px; }
      .face b { position: absolute; right: -2px; bottom: -2px; width: 8px; height: 8px; border-radius: 50%; background: var(--tone);
        box-shadow: 0 0 0 1.5px #12151c; animation: beat 1.8s ease-in-out infinite; }
      :host([data-paused="1"]) .face b { animation: none; }
      @keyframes beat { 50% { opacity: 0.35; } }
      .words { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
      .title { font-weight: 600; white-space: nowrap; }
      .sub { display: flex; min-width: 0; color: #8b93a7; font-size: 11px; white-space: nowrap; }
      .text { overflow: hidden; text-overflow: ellipsis; max-width: 230px; }
      button { all: unset; cursor: pointer; padding: 6px 12px; border-radius: 7px; font-weight: 600; white-space: nowrap;
        border: 1px solid #262b36; background: #181c26; transition: background 140ms ease, border-color 140ms ease; }
      button:hover { border-color: #3a4150; background: rgba(38, 43, 54, 0.7); }
      button.stop { color: var(--danger); background: rgba(240, 113, 120, 0.1); border-color: rgba(240, 113, 120, 0.25); }
      button.stop:hover { background: rgba(240, 113, 120, 0.17); border-color: rgba(240, 113, 120, 0.45); }
      @media (prefers-reduced-motion: reduce) { .glow, .face b { animation: none; } }
    </style>
    <div class="glow"></div>
    <div class="bar"><span class="face"><i></i><i></i><b></b></span><span class="words"><span class="title"></span><span class="sub"><span class="text"></span><span class="left"></span></span></span><button data-act="take"></button><button class="stop" data-act="stop">Stop</button></div>`;
    title = shadow.querySelector(".title");
    text = shadow.querySelector(".text");
    left = shadow.querySelector(".left");
    take = shadow.querySelector('button[data-act]:not(.stop)');
    shadow.addEventListener(
      "click",
      (e) => {
        const button = (e.target as HTMLElement).closest("button");
        if (!button) return;
        e.stopPropagation();
        e.preventDefault();
        tell({ kind: button.dataset["act"] });
      },
      true,
    );
    document.documentElement.appendChild(host);
    // A page that rewrites itself takes the overlay with it; put back.
    new MutationObserver(() => {
      if (!removed && host && !host.isConnected) document.documentElement?.appendChild(host);
    }).observe(document.documentElement, { childList: true });
    render();
  };

  // The owner's hand on the page, for the extension to tell from KOS's.
  const report = (e: Event): void => {
    if (!e.isTrusted || (host && e.composedPath().includes(host))) return;
    const pointer = e as PointerEvent;
    const key = e as KeyboardEvent;
    tell({
      kind: "input",
      type: e.type,
      ...(e.type === "keydown" ? { key: key.key } : { x: pointer.clientX, y: pointer.clientY }),
    });
  };
  for (const type of ["pointerdown", "keydown", "wheel"]) window.addEventListener(type, report, { capture: true, passive: true });

  w.__kos = {
    set(next) {
      state = next;
      render();
    },
    remove() {
      removed = true;
      host?.remove();
      for (const type of ["pointerdown", "keydown", "wheel"]) window.removeEventListener(type, report, { capture: true });
    },
  };
  setInterval(render, 30_000);
  if (document.documentElement) build();
  else document.addEventListener("readystatechange", build, { once: true });
  tell({ kind: "hello" });
}
