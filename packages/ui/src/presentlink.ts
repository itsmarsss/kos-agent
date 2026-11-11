/**
 * The presenter view and its audience window, kept on one slide. The
 * audience window is the dashboard's own page (`#/audience/<id>/<session>`,
 * AudienceWindow.tsx), opened from the owner's press, which frames the deck
 * the way the viewer does; the artifact never opens a window, its sandbox
 * refusing that by design. The two windows speak over a BroadcastChannel
 * named for the presentation, and each drives only its own deck frames.
 */

export type PresentSignal =
  /** The audience window is up: where is the presenter? */
  | { type: "hello" }
  /** The presenter's place, for the audience to show. */
  | { type: "go"; index: number }
  /** The audience's deck moved on its own (a key pressed in that window), for the presenter to follow. */
  | { type: "moved"; index: number }
  /** Presenting is over: the audience window closes. */
  | { type: "end" };

const place = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 10_000 ? v : undefined);

/** A signal as heard, checked: anything else on the channel is no signal. */
export function readSignal(data: unknown): PresentSignal | undefined {
  if (!data || typeof data !== "object") return undefined;
  const m = data as { type?: unknown; index?: unknown };
  if (m.type === "hello" || m.type === "end") return { type: m.type };
  if (m.type === "go" || m.type === "moved") {
    const index = place(m.index);
    return index === undefined ? undefined : { type: m.type, index };
  }
  return undefined;
}

export interface PresentLink {
  post(signal: PresentSignal): void;
  /** Hear the other window's signals; returns the way to stop. */
  listen(heard: (signal: PresentSignal) => void): () => void;
  close(): void;
}

/** The channel for one presentation, between windows of the dashboard's own origin. */
export function presentLink(session: string): PresentLink {
  const channel = new BroadcastChannel(`kos-present:${session}`);
  return {
    post: (signal) => channel.postMessage(signal),
    listen: (heard) => {
      const on = (e: MessageEvent): void => {
        const signal = readSignal(e.data);
        if (signal) heard(signal);
      };
      channel.addEventListener("message", on);
      return () => channel.removeEventListener("message", on);
    },
    close: () => channel.close(),
  };
}

/** A name for one presentation: random, and made where randomUUID is not (a dashboard on plain http). */
export function presentSession(): string {
  return [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const AUDIENCE = /^#\/audience\/([^/]+)\/([0-9a-f]{8,64})$/;

export const audienceHash = (id: string, session: string): string => `#/audience/${encodeURIComponent(id)}/${session}`;

/** The audience window's route, or none: it is drawn alone, without the dashboard around it (main.tsx). */
export function audienceRoute(hash: string): { id: string; session: string } | undefined {
  const m = AUDIENCE.exec(hash);
  if (!m) return undefined;
  try {
    return { id: decodeURIComponent(m[1]!), session: m[2]! };
  } catch {
    return undefined;
  }
}

/**
 * Open the audience window, from the owner's press (a pop-up needs one): the
 * dashboard's own page at the audience route, a window of its own to drag
 * onto the projector. None when the browser blocks it.
 */
export function openAudience(id: string, session: string): Window | null {
  const url = `${location.origin}${location.pathname}${audienceHash(id, session)}`;
  return window.open(url, `kos-audience-${session}`, "popup,width=1280,height=760");
}
