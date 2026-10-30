/**
 * What the owner sees on a tab KOS is using: a glowing border, and a small
 * bar saying what KOS is doing, with Take over and Stop.
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
  let text: HTMLElement | null = null;
  let left: HTMLElement | null = null;
  let take: HTMLButtonElement | null = null;
  let removed = false;

  const minutes = (): string => {
    const m = Math.max(0, Math.ceil((state.until - Date.now()) / 60_000));
    return state.until ? ` · ${m} min left` : "";
  };
  const render = (): void => {
    if (!host || !text || !take || !left) return;
    host.dataset["paused"] = state.paused ? "1" : "";
    text.textContent = state.paused ? "You have this tab" : `KOS: ${state.task || "working"}`;
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
    shadow.innerHTML = `<style>
      .glow { position: fixed; inset: 0; pointer-events: none; border-radius: 6px;
        box-shadow: inset 0 0 0 2px rgba(139, 92, 246, 0.95), inset 0 0 22px 4px rgba(139, 92, 246, 0.45);
        animation: breathe 2.4s ease-in-out infinite; }
      :host([data-paused="1"]) .glow { box-shadow: inset 0 0 0 2px rgba(245, 158, 11, 0.9), inset 0 0 18px 2px rgba(245, 158, 11, 0.35); animation: none; }
      @keyframes breathe { 50% { opacity: 0.55; } }
      .bar { position: fixed; right: 14px; bottom: 14px; pointer-events: auto; display: flex; align-items: center; gap: 8px;
        max-width: min(460px, calc(100vw - 28px)); padding: 6px 6px 6px 12px; border-radius: 999px;
        background: rgba(17, 17, 24, 0.92); color: #ececf1; font: 500 12px/1.2 -apple-system, system-ui, sans-serif;
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(139, 92, 246, 0.5); }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #8b5cf6; flex: none; animation: breathe 1.2s ease-in-out infinite; }
      :host([data-paused="1"]) .dot { background: #f59e0b; animation: none; }
      .text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .left { color: #a1a1aa; white-space: nowrap; }
      button { all: unset; cursor: pointer; padding: 4px 10px; border-radius: 999px; background: rgba(255, 255, 255, 0.1); font-weight: 600; white-space: nowrap; }
      button:hover { background: rgba(255, 255, 255, 0.2); }
      button.stop { background: rgba(239, 68, 68, 0.85); }
      button.stop:hover { background: rgb(239, 68, 68); }
    </style>
    <div class="glow"></div>
    <div class="bar"><span class="dot"></span><span class="text"></span><span class="left"></span><button data-act="take"></button><button class="stop" data-act="stop">Stop</button></div>`;
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
