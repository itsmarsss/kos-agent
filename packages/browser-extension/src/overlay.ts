/**
 * What the owner sees on a tab KOS is using: a glowing border, and a small
 * bar saying what KOS is doing, with Take over and Stop. The same pieces as
 * KOS for Mac puts over a Mac: the border sweeping blue into violet, amber and
 * still while the owner has it; the bar with KOS's face, two lines and the
 * app's own buttons, capsules inside a capsule. The bar is the owner's to
 * put out of the way: dragged anywhere on the page, or folded to KOS's face
 * by a press on the face, and kept so for the session's other pages.
 *
 * KOS's cursor is KOS for Mac's, drawn the same (KOSCursor.swift): the arrow
 * in the overlay's blue, lit from behind, a halo round its tip and a tag that
 * says whose it is, in the dark palette over any page as the Mac's is over any
 * screen. It moves as the Mac's does (DeviceCore's Glide): along a shallow
 * arc, eased in and out, longer the further it goes, and ripples on a press.
 * It is on the page from the start, in the middle until KOS points somewhere,
 * and stays where it last was, as a pointer does when the page under it
 * scrolls. It goes while the owner has the tab and comes back where it was on
 * Hand back. Its arrow is in KOS's own pictures, as the Mac's pointer is in
 * its; its halo and tag are not, so they cover nothing KOS reads.
 *
 * Only the top frame draws: a page of frames would otherwise wear a border
 * and a bar in each. Every frame reports the owner's hand, since a click in
 * a frame is still the owner taking over. It goes by itself when the
 * extension stops checking in, so a session that ended leaves nothing on
 * the page whatever became of the connection.
 *
 * Put in the page over the debugging connection, into a world of its own
 * (the page's scripts cannot reach it), so the extension needs no
 * permission to read the owner's sites. Hidden from the accessibility tree,
 * so KOS's own reading of the page does not take it for the page. It also
 * reports the owner's clicks and keys, for the extension to tell from
 * KOS's own. It runs in the page, so it stands alone: nothing from outside.
 */

import type { CursorLook } from "./cursorlook.js";

export interface OverlayState {
  task: string;
  paused: boolean;
  /** When the session ends, epoch ms. */
  until: number;
  /** Where the owner put the bar: its top-left corner, as fractions of the page's width and height. */
  at?: { x: number; y: number };
  /** Folded to KOS's face. */
  folded?: boolean;
  /** The face of the KOS at work: its colours, its eyes, and its outline as a path in a 100-unit box. */
  face?: { fill: string; ink: string; eyes: string; body: string };
  /** The palette the bar is drawn in: the extension's theme, "system" being the page's own appearance. */
  theme?: "light" | "dark" | "system";
  /** False when the owner chose the small bar in Settings: KOS's face and Stop alone, still one press to stop, with the border and KOS's cursor. */
  bar?: boolean;
}

/**
 * How KOS's cursor goes to a point: `move` glides there, `press` glides and
 * ripples, `drag` follows the held button closely, `rest` puts it there a
 * moment later unless KOS points again first (an element scrolled to, where
 * a press often follows somewhere near), and `place` puts it there at once,
 * on a new page of the same tab.
 */
export type PointHow = "move" | "press" | "drag" | "rest" | "place";

export function installOverlay(look: CursorLook): void {
  const w = window as unknown as {
    __kos?: {
      set(state: OverlayState): void;
      remove(): void;
      alive(): void;
      point(x: number, y: number, how: PointHow): number;
      typing(): void;
      capturing(on: boolean): Promise<void>;
    };
    kosOverlay?: (payload: string) => void;
  };
  if (w.__kos) return;
  const top = window.top === window;
  // Gone unless the extension says otherwise this often: it does every few seconds while the session lasts.
  const ALIVE_MS = 9_000;
  // KOS for Mac's glide (DeviceCore's Glide), its quick one: longer the further it goes, within bounds, eased in and out.
  const { glide: g } = look;
  const glideMs = (distance: number): number => (distance > 0 ? 1000 * g.quickShare * (g.shortest + (g.longest - g.shortest) * Math.min(1, distance / g.far)) : 0);
  const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  // A held button's moves come a few milliseconds apart: each is followed this quickly.
  const DRAG_MS = 60;
  // An element scrolled to: the cursor goes there this much later, unless KOS points again first.
  const REST_MS = 150;
  /**
   * At most `n` a second of something a page could make the overlay do over
   * and over; one asked for past that runs once more as the second ends, so
   * the page's last word is answered too.
   */
  const limited = (n: number, run: () => void): (() => void) => {
    let since = 0;
    let used = 0;
    let trailing: ReturnType<typeof setTimeout> | undefined;
    const go = (): void => {
      const now = Date.now();
      if (now - since > 1000) [since, used] = [now, 0];
      if (++used <= n) return run();
      trailing ??= setTimeout(() => {
        trailing = undefined;
        go();
      }, since + 1000 - now + 1);
    };
    return go;
  };
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
  let bar: HTMLElement | null = null;
  let cursor: HTMLElement | null = null;
  let tag: HTMLElement | null = null;
  let face: HTMLElement | null = null;
  /** Where KOS has pointed, in the page's viewport; until it has, its cursor is in the middle, however the page is resized. */
  let at: { x: number; y: number } | null = null;
  const middle = (): { x: number; y: number } => ({ x: innerWidth / 2, y: innerHeight / 2 });
  let glide: Animation | undefined;
  let resting: ReturnType<typeof setTimeout> | undefined;
  let typed: ReturnType<typeof setTimeout> | undefined;
  let removed = false;
  let lastAlive = Date.now();

  const minutes = (): string => {
    const m = Math.max(0, Math.ceil((state.until - Date.now()) / 60_000));
    if (!state.until) return "";
    return m <= 1 ? " · under a minute left" : ` · ${m} min left`;
  };
  /** The bar where the owner put it, kept on the page however the page is resized. */
  const place = (): void => {
    if (!bar) return;
    if (!state.at) {
      bar.style.left = bar.style.top = "";
      bar.style.right = bar.style.bottom = "14px";
      return;
    }
    const x = Math.min(Math.max(0, state.at.x * innerWidth), Math.max(0, innerWidth - bar.offsetWidth));
    const y = Math.min(Math.max(0, state.at.y * innerHeight), Math.max(0, innerHeight - bar.offsetHeight));
    bar.style.right = bar.style.bottom = "auto";
    bar.style.left = `${x}px`;
    bar.style.top = `${y}px`;
  };
  /** Where the cursor's tip is drawn now, mid-glide or not. */
  const drawnAt = (): { x: number; y: number } => {
    const m = cursor ? new DOMMatrix(getComputedStyle(cursor).transform) : undefined;
    return m ? { x: m.e, y: m.f } : (at ?? middle());
  };
  /** Whether anyone sees the cursor move: on a tab in front (its window need not be, as while the owner types beside it), for an owner who has not asked for less motion. */
  const seen = (): boolean => document.visibilityState === "visible" && !matchMedia("(prefers-reduced-motion: reduce)").matches;
  /** The cursor's tip on a point at once. */
  const setTip = (to: { x: number; y: number }): void => {
    glide?.cancel();
    if (cursor) cursor.style.transform = `translate(${to.x}px, ${to.y}px)`;
  };
  /**
   * The cursor's tip to a point along the Mac's path: a control point off to
   * one side of the straight line bends it into a shallow arc, as a hand
   * moving a mouse does. Says how long it takes (none when no one would see
   * it), and when it is there; `ms` fixes the time.
   */
  const glideTo = (to: { x: number; y: number }, ms?: number): { ms: number; arrived: Promise<void> } => {
    const it = cursor;
    if (!it) return { ms: 0, arrived: Promise.resolve() };
    const from = drawnAt();
    setTip(to);
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const duration = ms ?? glideMs(distance);
    const steps = Math.round((duration / 1000) * g.rate);
    if (steps <= 1 || !seen()) return { ms: 0, arrived: Promise.resolve() };
    const bend = Math.min(g.bendMost, distance * g.bendShare);
    const control = { x: (from.x + to.x) / 2 - ((to.y - from.y) / distance) * bend, y: (from.y + to.y) / 2 + ((to.x - from.x) / distance) * bend };
    const frames = [from];
    for (let step = 1; step <= steps; step++) {
      const t = ease(step / steps);
      const u = 1 - t;
      frames.push({ x: u * u * from.x + 2 * u * t * control.x + t * t * to.x, y: u * u * from.y + 2 * u * t * control.y + t * t * to.y });
    }
    glide = it.animate(
      frames.map((p) => ({ transform: `translate(${p.x}px, ${p.y}px)` })),
      { duration, easing: "linear" },
    );
    return {
      ms: duration,
      arrived: glide.finished.then(
        () => undefined,
        () => undefined,
      ),
    };
  };
  /** The overlay to the top of the top layer, over whatever the page last put there. */
  const raise = limited(10, () => {
    if (!host?.isConnected || removed) return;
    try {
      if (host.matches(":popover-open")) host.hidePopover();
      host.showPopover();
    } catch {
      /* a browser without popovers: the z-index is all there is */
    }
  });
  const ripple = (): void => {
    if (!cursor) return;
    cursor.classList.remove("press");
    void cursor.offsetWidth;
    cursor.classList.add("press");
  };

  /** A mark on the host, written only when it changes: the host is watched, and a write that changes nothing is still heard. */
  const mark = (key: string, value: string): void => {
    if (host && host.dataset[key] !== value) host.dataset[key] = value;
  };
  let capture = false;
  let stopped = false;
  const render = (): void => {
    if (!host || !title || !text || !take || !left) return;
    mark("paused", state.paused ? "1" : "");
    const small = state.bar === false;
    // The small bar is already as small as it goes: never folded, whatever the full bar was left as.
    mark("folded", state.folded && !small ? "1" : "");
    mark("theme", state.theme ?? "system");
    mark("bar", state.bar === false ? "chip" : "");
    mark("capture", capture ? "1" : "");
    title.textContent = state.paused ? "Paused, you have control" : "KOS is using this tab";
    text.textContent = state.task || "working";
    left.textContent = minutes();
    take.textContent = state.paused ? "Hand back" : "Take over";
    take.dataset["act"] = state.paused ? "handback" : "take";
    if (face && state.face) {
      face.style.setProperty("--fill", state.face.fill);
      face.style.setProperty("--ink", state.face.ink);
      face.dataset["eyes"] = state.face.eyes;
      face.querySelector("path")?.setAttribute("d", state.face.body);
    }
    bar?.setAttribute("title", small ? `${title.textContent}: ${state.task || "working"}. Drag to move.` : state.folded ? `${title.textContent}: ${state.task || "working"}. Press KOS's face to open the bar.` : "Drag to move. Press KOS's face to fold.");
    place();
  };

  // Every rule its own and important, so no style of the page's reaches it.
  const HOST_STYLE = "all: initial !important; position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; pointer-events: none !important;";
  const STOPPED_STYLE = `${HOST_STYLE} display: none !important;`;
  /** The host's style as the browser wrote it back, to tell the page's change from none. */
  let styled = "";
  const styleHost = (style: string): void => {
    if (!host) return;
    host.setAttribute("style", style);
    styled = host.getAttribute("style") ?? "";
  };
  /** The host as the overlay made it, put back when the page changes its style, its popover or its marks. */
  const restore = limited(10, () => {
    if (!host || removed) return;
    if (host.getAttribute("style") !== styled) styleHost(stopped ? STOPPED_STYLE : HOST_STYLE);
    if (host.getAttribute("popover") !== "manual") {
      host.setAttribute("popover", "manual");
      raise();
    }
    if (host.getAttribute("aria-hidden") !== "true") host.setAttribute("aria-hidden", "true");
    render();
  });

  const build = (): void => {
    if (!top || removed || host || !document.documentElement) return;
    host = document.createElement("kos-overlay");
    host.setAttribute("aria-hidden", "true");
    styleHost(HOST_STYLE);
    // Drawn in the top layer, over the page's own dialogs and anything it puts full screen, which no z-index is above.
    host.setAttribute("popover", "manual");
    const shadow = host.attachShadow({ mode: "closed" });
    // KOS's face as @kos/shared colours it, written in rather than imported,
    // since this function runs in the page on its own; extension.test.ts keeps
    // them in step. The KOS at work sends its own, outline and all, with the state.
    const kos = { fill: "#3585ed", ink: "#141d29" };
    // The light palette, the dashboard's light tokens: on its own choice, or on the page's light appearance under "system".
    // The bar is opaque, edged in its tone and shadowed either way, so it reads on a light site and a dark one alike.
    // Each token important: a page's rule on the host would otherwise win over :host, and recolour or hide the overlay.
    const important = (tokens: string): string => tokens.replace(/;/g, " !important;");
    const light = important(`--accent: #3558d6; --violet: #7b4fd6; --warn: #7d5400; --danger: #cf3b47;
        --bar: rgba(255, 255, 255, 0.97); --ink: #161a22; --sub: #58607a; --btn: #eceef3; --btn-line: #dde1e8; --btn-line-lit: #bfc6d3;
        --btn-lit: #dde1e8; --cast: rgba(16, 24, 40, 0.2);`);
    const dark = important(`--accent: #7c9cff; --violet: #a57cff; --warn: #e6b84d; --danger: #f07178; --tone: var(--accent);
        --bar: rgba(18, 21, 28, 0.96); --ink: #e7ebf3; --sub: #8b93a7; --btn: #181c26; --btn-line: #262b36; --btn-line-lit: #3a4150;
        --btn-lit: rgba(38, 43, 54, 0.7); --cast: rgba(0, 0, 0, 0.35);`);
    const c = look;
    const px = (n: number): string => `${n}px`;
    const blue = (share: number): string => `color-mix(in srgb, var(--kos-blue) ${share * 100}%, transparent)`;
    shadow.innerHTML = `<style>
      :host { ${dark} }
      :host([data-theme="light"]) { ${light} }
      @media (prefers-color-scheme: light) { :host([data-theme="system"]) { ${light} } }
      :host([data-paused="1"]) { --tone: var(--warn) !important; }
      .glow { position: fixed; inset: 0; pointer-events: none; border-radius: 6px;
        box-shadow: inset 0 0 0 2px var(--accent), inset 0 0 24px 4px color-mix(in srgb, var(--accent) 40%, transparent);
        animation: sweep 3.2s ease-in-out infinite; }
      :host([data-paused="1"]) .glow { box-shadow: inset 0 0 0 2px var(--warn), inset 0 0 18px 2px color-mix(in srgb, var(--warn) 35%, transparent); animation: none; }
      @keyframes sweep { 50% { box-shadow: inset 0 0 0 2px var(--violet), inset 0 0 28px 6px color-mix(in srgb, var(--violet) 42%, transparent); } }
      .bar { position: fixed; right: 14px; bottom: 14px; pointer-events: auto; display: flex; align-items: center; gap: 12px;
        max-width: min(480px, calc(100vw - 28px)); height: 48px; padding: 0 8px 0 12px; border-radius: 999px; cursor: grab; user-select: none;
        touch-action: none;
        background: var(--bar); color: var(--ink); font: 12.5px/1.25 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
        -webkit-font-smoothing: antialiased;
        border: 1px solid color-mix(in srgb, var(--tone) 55%, transparent);
        box-shadow: 0 0 12px color-mix(in srgb, var(--tone) 35%, transparent), 0 8px 24px var(--cast); }
      .bar.dragging { cursor: grabbing; }
      :host([data-bar="chip"]) .bar { gap: 6px; height: 38px; padding: 0 5px 0 7px; }
      :host([data-bar="chip"]) .words, :host([data-bar="chip"]:not([data-paused="1"])) button:not(.stop) { display: none; }
      :host([data-bar="chip"]) button { box-sizing: border-box; height: 26px; padding: 0 11px; line-height: 24px; }
      :host([data-folded="1"]) .bar { gap: 0; padding: 0 11px; opacity: 0.85; }
      :host([data-folded="1"]) .bar:hover { opacity: 1; }
      :host([data-folded="1"]) .words, :host([data-folded="1"]) button { display: none; }
      .face { --fill: ${kos.fill}; --ink: ${kos.ink}; cursor: pointer; position: relative; flex: none; width: 26px; height: 26px;
        border-radius: 50% 50% 47% 53% / 52% 50% 50% 48%; background: var(--fill);
        display: flex; align-items: center; justify-content: center; gap: 5px; }
      .face:has(path[d]) { background: none; }
      .face svg { position: absolute; inset: -2px; width: 30px; height: 30px; }
      .face path { fill: var(--fill); }
      .face i { position: relative; width: 3px; height: 6px; border-radius: 2px; background: var(--ink); margin-top: -2px; }
      .face[data-eyes="round"] i { width: 4px; height: 4px; }
      .face b { position: absolute; right: -2px; bottom: -2px; width: 8px; height: 8px; border-radius: 50%; background: var(--tone);
        box-shadow: 0 0 0 1.5px var(--bar); animation: beat 1.8s ease-in-out infinite; }
      :host([data-paused="1"]) .face b { animation: none; }
      @keyframes beat { 50% { opacity: 0.35; } }
      .words { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
      .title { font-weight: 600; white-space: nowrap; }
      .sub { display: flex; min-width: 0; color: var(--sub); font-size: 11px; white-space: nowrap; }
      .text { overflow: hidden; text-overflow: ellipsis; max-width: 230px; }
      button { all: unset; cursor: pointer; padding: 6px 13px; border-radius: 999px; font-weight: 600; white-space: nowrap;
        border: 1px solid var(--btn-line); background: var(--btn); transition: background 140ms ease, border-color 140ms ease; }
      button:hover { border-color: var(--btn-line-lit); background: var(--btn-lit); }
      button.stop { color: var(--danger); background: color-mix(in srgb, var(--danger) 10%, transparent); border-color: color-mix(in srgb, var(--danger) 25%, transparent); }
      button.stop:hover { background: color-mix(in srgb, var(--danger) 17%, transparent); border-color: color-mix(in srgb, var(--danger) 45%, transparent); }
      .cursor { --kos-blue: ${c.blue}; --kos-ink: ${c.ink}; position: fixed; left: 0; top: 0; width: 0; height: 0; pointer-events: none; }
      :host([data-paused="1"]) .cursor, :host([data-capture="1"]) .cursor :is(.halo, .ring, .tag) { visibility: hidden; }
      .cursor svg { position: absolute; left: 0; top: 0; overflow: visible;
        filter: drop-shadow(0 0 ${px(c.glow.radius / 2)} var(--kos-blue)) drop-shadow(0 0 ${px(c.glow.radius / 2)} ${blue(c.glow.opacity)}); }
      .cursor path { fill: var(--kos-blue); stroke: #fff; stroke-width: ${px(c.stroke)}; stroke-linejoin: round; }
      .cursor .halo { position: absolute; left: ${px(-c.halo.radius)}; top: ${px(-c.halo.radius)}; width: ${px(2 * c.halo.radius)}; height: ${px(2 * c.halo.radius)};
        box-sizing: border-box; border-radius: 50%; background: ${blue(c.halo.fill)}; border: ${px(c.halo.line)} solid ${blue(c.halo.edge)}; }
      .cursor .ring { position: absolute; left: ${px(-c.ripple.radius)}; top: ${px(-c.ripple.radius)}; width: ${px(2 * c.ripple.radius)}; height: ${px(2 * c.ripple.radius)};
        box-sizing: border-box; border-radius: 50%; opacity: 0; background: ${blue(c.ripple.fill)}; border: ${px(c.ripple.line)} solid var(--kos-blue); }
      .cursor.press .ring { animation: ripple ${c.ripple.ms}ms ease-out; }
      @keyframes ripple { from { opacity: 0.95; transform: scale(${c.ripple.from}); } to { opacity: 0; transform: scale(${c.ripple.to}); } }
      .cursor .tag { position: absolute; left: ${px(c.tag.left)}; top: ${px(c.tag.top)}; height: ${px(c.tag.height)}; padding: 0 ${px(c.tag.padding)};
        border-radius: ${px(c.tag.radius)}; white-space: nowrap; background: var(--kos-blue); color: var(--kos-ink);
        font: ${c.tag.weight} ${px(c.tag.font)}/${px(c.tag.height)} -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
        -webkit-font-smoothing: antialiased; box-shadow: 0 1px 3px rgba(0, 0, 0, ${c.tag.shadow}); }
      @media (prefers-reduced-motion: reduce) { .glow, .face b, .cursor.press .ring { animation: none; } }
    </style>
    <div class="cursor"><span class="halo"></span><span class="ring"></span><svg width="${13 * c.scale}" height="${20 * c.scale}" aria-hidden="true"><path d="M${c.outline.map(([x, y]) => `${x * c.scale} ${y * c.scale}`).join("L")}Z"/></svg><span class="tag">KOS</span></div>
    <div class="glow"></div>
    <div class="bar"><span class="face"><svg viewBox="0 0 100 100" aria-hidden="true"><path/></svg><i></i><i></i><b></b></span><span class="words"><span class="title"></span><span class="sub"><span class="text"></span><span class="left"></span></span></span><button data-act="take"></button><button class="stop" data-act="stop">Stop</button></div>`;
    title = shadow.querySelector(".title");
    text = shadow.querySelector(".text");
    left = shadow.querySelector(".left");
    take = shadow.querySelector('button[data-act]:not(.stop)');
    bar = shadow.querySelector(".bar");
    cursor = shadow.querySelector(".cursor");
    tag = shadow.querySelector(".tag");
    face = shadow.querySelector(".face");
    setTip(at ?? middle());
    // A drag moves the bar; a press that does not move is a press, and on the face it folds the bar.
    // Whether it began on the face is kept: with the pointer captured, the release is the bar's, not the face's.
    let drag: { id: number; dx: number; dy: number; x0: number; y0: number; moved: boolean; face: boolean } | null = null;
    bar?.addEventListener("pointerdown", (e) => {
      if (!bar || (e.target as HTMLElement).closest("button")) return;
      const at = bar.getBoundingClientRect();
      drag = { id: e.pointerId, dx: e.clientX - at.left, dy: e.clientY - at.top, x0: e.clientX, y0: e.clientY, moved: false, face: !!(e.target as HTMLElement).closest(".face") };
      bar.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    bar?.addEventListener("pointermove", (e) => {
      if (!bar || !drag || e.pointerId !== drag.id) return;
      if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 4) return;
      drag.moved = true;
      bar.classList.add("dragging");
      state = { ...state, at: { x: (e.clientX - drag.dx) / innerWidth, y: (e.clientY - drag.dy) / innerHeight } };
      place();
    });
    bar?.addEventListener("pointerup", (e) => {
      if (!bar || !drag || e.pointerId !== drag.id) return;
      const { moved, face: onFace } = drag;
      drag = null;
      bar.classList.remove("dragging");
      if (moved && state.at) tell({ kind: "place", ...state.at });
      else if (onFace && state.bar !== false) tell({ kind: "fold", folded: !state.folded });
    });
    addEventListener("resize", () => {
      place();
      if (!at) setTip(middle());
    });
    shadow.addEventListener(
      "click",
      (e) => {
        const button = (e.target as HTMLElement).closest("button");
        if (!button) return;
        e.stopPropagation();
        e.preventDefault();
        // Stop is the owner's at once: the page is theirs again before the extension has done its part.
        if (button.dataset["act"] === "stop" && host) {
          stopped = true;
          styleHost(STOPPED_STYLE);
        }
        tell({ kind: button.dataset["act"] });
      },
      true,
    );
    document.documentElement.appendChild(host);
    raise();
    // A page that rewrites itself takes the overlay with it; put back.
    const reappend = limited(10, () => {
      if (removed || !host || host.isConnected) return;
      document.documentElement?.appendChild(host);
      raise();
    });
    new MutationObserver(() => host && !host.isConnected && reappend()).observe(document.documentElement, { childList: true });
    new MutationObserver(restore).observe(host, { attributes: true, attributeFilter: ["style", "popover", "aria-hidden", "data-paused", "data-folded", "data-theme", "data-bar", "data-capture"] });
    // The page's own popover or full screen goes over it in the top layer: it goes back over them. (A modal dialog
    // makes the rest of the page inert, the overlay too wherever it is drawn: the popup and the side panel still stop KOS.)
    document.addEventListener("toggle", (e) => e.target !== host && (e as ToggleEvent).newState === "open" && raise(), true);
    document.addEventListener("fullscreenchange", raise);
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

  const remove = (): void => {
    removed = true;
    host?.remove();
    clearInterval(ticker);
    for (const type of ["pointerdown", "keydown", "wheel"]) window.removeEventListener(type, report, { capture: true });
  };
  w.__kos = {
    set(next) {
      lastAlive = Date.now();
      state = next;
      render();
    },
    remove,
    alive() {
      lastAlive = Date.now();
    },
    // KOS's cursor to where its hands are about to act: answered at once with how long its glide takes, for KOS's hands to wait on their own clock.
    point(x, y, how) {
      lastAlive = Date.now();
      clearTimeout(resting);
      at = { x, y };
      if (!cursor) return 0;
      if (how === "rest") {
        resting = setTimeout(() => at && setTip(at), REST_MS);
        return 0;
      }
      if (how === "place") {
        setTip(at);
        return 0;
      }
      const glided = glideTo(at, how === "drag" ? DRAG_MS : undefined);
      if (how === "press") void glided.arrived.then(ripple);
      return how === "drag" ? 0 : glided.ms;
    },
    // While KOS types, the tag says so; it settles back once the typing stops.
    typing() {
      if (!tag) return;
      tag.textContent = "KOS · typing";
      clearTimeout(typed);
      typed = setTimeout(() => {
        if (tag) tag.textContent = "KOS";
      }, 800);
    },
    // While KOS takes its picture of the page: the arrow alone, answered once a frame without the rest is drawn.
    capturing(on) {
      if (!host) return Promise.resolve();
      capture = on;
      mark("capture", on ? "1" : "");
      if (!on || document.visibilityState !== "visible") return Promise.resolve();
      return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    },
  };
  // Re-read the time left, and go if the extension has not been heard from: the session is over.
  const ticker = setInterval(() => {
    if (Date.now() - lastAlive > ALIVE_MS) remove();
    else restore();
  }, 3_000);
  if (document.documentElement) build();
  else document.addEventListener("readystatechange", build, { once: true });
  tell({ kind: "hello" });
}
