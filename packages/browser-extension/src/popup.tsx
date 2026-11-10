import { KOS_SEED } from "@kos/shared";
import type { BlobMood } from "@kos/shared/blobmotion";
import { ChatIcon, ChevronLeft, Chips, Collapse, DrawerRow, Face, Field, GearIcon, GlobeIcon, HandIcon, HiddenIcon, IconButton, Pill, PlusIcon, Section, ServerIcon, StatusDot, Switch, Tag, type Tone, arrive, ease, fromTop, pageMove, spring, useOverlayScroll } from "@kos/kit";
import { AnimatePresence, LayoutGroup, LazyMotion, MotionConfig, domMax, m } from "motion/react";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

import { kosAddress, parsePairing } from "./address.js";
import { CHOICES, isHidden, siteOf, type Takeover, type ThemeChoice } from "./settings.js";
import { asWords, linkWords, needsPairing } from "./linkwords.js";
import { ask, minutesLeft, minutesWords } from "./pages.js";
import type { KosState, PopupState } from "./worker.js";

/**
 * The popup under the KOS icon, laid out as KOS for Mac's window is and
 * moving as the dashboard does: KOS's face and where it stands, with the
 * way to the side panel's chat; the live session; this tab, to give or
 * take back; each KOS folded to a line, opening to its rules and its line;
 * the sites hidden from KOS; and behind the gear, the owner's settings for
 * this Chrome. It reads the worker's state and asks the worker for every
 * change.
 */

const connected = (k: KosState): boolean => k.link === "online" && !k.held;

/** How KOS looks in the head, as on KOS for Mac: at work in a session, at ease while a KOS is connected or on its way, asleep when the owner disconnected each, sagging when none can be reached. */
function mood(s: PopupState | undefined): BlobMood {
  if (!s || !s.kos.length) return "idle";
  if (s.session) return s.session.paused ? "idle" : "working";
  if (s.kos.some((k) => connected(k) || (!k.held && k.link === "connecting"))) return "idle";
  return s.kos.every((k) => k.held) ? "asleep" : "error";
}

/** The page's whole state: the worker's, the tab in front, and an error to show. */
function usePopup(): { state: PopupState | undefined; tab: chrome.tabs.Tab | undefined; error: string; dismiss: () => void; act: (message: Record<string, unknown>) => Promise<boolean> } {
  const [state, setState] = useState<PopupState>();
  const [tab, setTab] = useState<chrome.tabs.Tab>();
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    const [front] = await chrome.tabs.query({ active: true, currentWindow: true });
    setTab(front);
    setState(await ask<PopupState>({ type: "state" }));
  }, []);
  useEffect(() => {
    void refresh().catch((e: unknown) => setError(String(e instanceof Error ? e.message : e)));
    const timer = setInterval(() => void refresh().catch(() => undefined), 2_000);
    return () => clearInterval(timer);
  }, [refresh]);
  const act = useCallback(async (message: Record<string, unknown>): Promise<boolean> => {
    setError("");
    try {
      setState(await ask<PopupState>(message));
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }, []);
  const dismiss = useCallback(() => setError(""), []);
  return { state, tab, error, dismiss, act };
}

function Popup(): ReactElement {
  const { state, tab, error, dismiss, act } = usePopup();
  const [page, setPage] = useState<"home" | "settings">("home");
  // The popup keeps one size; its page scrolls inside, under the overlay thumb, no lane taken from its 392 px.
  const scroller = useRef<HTMLDivElement>(null);
  const overlay = useOverlayScroll(scroller);
  const pages = { home: useRef<HTMLElement>(null), settings: useRef<HTMLElement>(null) };
  // Settings open at their top, and home where it starts, not wherever the last page was scrolled to.
  // The page leaving is held where it was scrolled to as the scroll goes back, so it leaves from there.
  const go = (next: "home" | "settings"): void => {
    const view = scroller.current;
    const leaving = pages[page].current;
    if (view && leaving) {
      leaving.style.top = `${-view.scrollTop}px`;
      view.scrollTop = 0;
    }
    // Back before it was gone: it comes in from where it is, not held.
    pages[next].current?.style.removeProperty("top");
    setPage(next);
  };
  return (
    <div className="popup-frame">
      <div className="popup-page" ref={overlay}>
        {/* Home and settings move at once, each from its own side, as KOS for Mac's pages do; the head is home's. */}
        <div className="pages">
          <AnimatePresence initial={false}>
            {page === "home" ? (
              <m.main key="home" ref={pages.home} className="stack page" custom={-1} variants={pageMove} initial="out" animate="in" exit="out">
                <Head state={state} settings={() => go("settings")} />
                {state && <Home state={state} tab={tab} act={act} />}
              </m.main>
            ) : (
              <m.main key="settings" ref={pages.settings} className="stack page" custom={1} variants={pageMove} initial="out" animate="in" exit="out">
                {state && <SettingsPage state={state} act={act} back={() => go("home")} />}
              </m.main>
            )}
          </AnimatePresence>
        </div>
      </div>
      <AnimatePresence>
        {error && (
          <m.p className="error popup-error" role="alert" title="Dismiss" onClick={dismiss} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            {error}
          </m.p>
        )}
      </AnimatePresence>
    </div>
  );
}

/** KOS's face, the name over where it stands (the pill, then which KOS), and chat and the gear at the right. */
function Head({ state, settings }: { state: PopupState | undefined; settings: () => void }): ReactElement {
  const live = state?.session && !state.session.paused;
  const best = state?.kos.find(connected) ?? state?.kos[0];
  // The head says what the card of the KOS it shows says, or that a session has this Chrome.
  const pill: { word: string; tone: Tone } = state?.session ? (live ? { word: "Working", tone: "accent" } : { word: "Paused", tone: "warn" }) : best ? linkWords(best) : { word: "Not paired", tone: "muted" };
  return (
    <header className="head">
      <Face seed={KOS_SEED} size={40} mood={mood(state)} drawing={state?.session?.face ?? best?.face} label="KOS" />
      <div className="head-text">
        <strong>KOS for Chrome</strong>
        <span className="head-status">
          <StatePill tone={pill.tone} word={pill.word} />
          {best && (
            <m.span className="sub" layout="position">
              {state && state.kos.length > 1 ? `${best.host} and ${state.kos.length - 1} more` : best.host}
            </m.span>
          )}
        </span>
      </div>
      <span className="head-actions">
        <AnimatePresence initial={false}>
          {state?.kos.length ? (
            <IconButton key="panel" label="Chat with KOS" title="Chat with KOS beside your tabs" onClick={() => void openPanel()} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <ChatIcon size={14} />
            </IconButton>
          ) : null}
        </AnimatePresence>
        <IconButton label="Settings" onClick={settings}>
          <GearIcon size={14} title="" />
        </IconButton>
      </span>
    </header>
  );
}

/** A state's pill that changes as KOS for Mac's does: the old words fade out where they were, the new fade in, and what follows moves over. */
function StatePill({ tone, word }: { tone: Tone; word: string }): ReactElement {
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <m.span key={word} className="state-pill" layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ opacity: ease, layout: spring }}>
        <Pill tone={tone}>{word}</Pill>
      </m.span>
    </AnimatePresence>
  );
}

type Act = (message: Record<string, unknown>) => Promise<boolean>;

/** What the footnote under the hidden sites points to, as KOS for Mac's points to its own. */
const SAFETY = "https://github.com/itsmarsss/kos-agent/blob/main/docs/browser-extension.md#security-model";

/** The side panel, in this window: Chrome opens one only from a press, and the popup's is one. */
async function openPanel(): Promise<void> {
  const win = await chrome.windows.getCurrent();
  if (win.id !== undefined) await chrome.sidePanel.open({ windowId: win.id });
  window.close();
}

// The home page.

function Home({ state, tab, act }: { state: PopupState; tab: chrome.tabs.Tab | undefined; act: Act }): ReactElement {
  return (
    // One layout: a card arriving or a drawer opening in one section moves the sections under it, on the spring.
    <LayoutGroup>
      <div className="stack">
        <AnimatePresence initial={false}>{state.session && <SessionCard key="session" session={state.session} act={act} />}</AnimatePresence>
        {state.kos.length > 0 && <ThisTab state={state} tab={tab} act={act} />}
        <KosSection state={state} act={act} />
        <HiddenSection state={state} tab={tab} act={act} />
      </div>
    </LayoutGroup>
  );
}

function SessionCard({ session, act }: { session: NonNullable<PopupState["session"]>; act: Act }): ReactElement {
  return (
    <m.section className="card card--live" data-paused={session.paused || undefined} layout variants={fromTop} initial="hidden" animate="show" exit="hidden">
      <div className="session-head">
        <StatusDot state={session.paused ? "needs-you" : "working"} label={session.paused ? "Paused" : "Working"} />
        <strong>{session.paused ? "Paused, you have control" : "KOS is using this Chrome"}</strong>
        <span className="hint">{minutesLeft(session.until)}</span>
      </div>
      <p className="quote">{session.task}</p>
      <p className="hint">
        Asked from <strong>{session.requester}</strong>
        {session.kos ? ` on ${session.kos}` : ""}
      </p>
      <div className="row">
        <button type="button" className="btn" onClick={() => void act({ type: session.paused ? "handback" : "take" })}>
          {session.paused ? "Hand back" : "Take over"}
        </button>
        <button type="button" className="btn btn--danger" onClick={() => void act({ type: "stop" })}>
          Stop
        </button>
      </div>
    </m.section>
  );
}

function ThisTab({ state, tab, act }: { state: PopupState; tab: chrome.tabs.Tab | undefined; act: Act }): ReactElement | null {
  const url = tab?.url ?? "";
  if (!tab || !/^https?:\/\//.test(url)) return null;
  const host = new URL(url).host;
  const hidden = isHidden(url, state.settings.hiddenSites);
  const given = tab.id !== undefined && state.handed.includes(tab.id);
  const site = state.settings.hiddenSites.find((x) => isHidden(url, [x]));
  return (
    <Section label="This tab">
      <div className="card">
        <div className="line">
          <span className="tile">{tab.favIconUrl ? <img src={tab.favIconUrl} alt="" /> : <GlobeIcon />}</span>
          <div className="line-text">
            <strong>{tab.title || host}</strong>
            <span>{hidden ? `${host} · hidden from KOS` : given ? `${host} · KOS can work here` : host}</span>
          </div>
        </div>
        {hidden ? (
          <button type="button" className="btn btn--wide" onClick={() => void act({ type: "unhide", site })}>
            Show this site to KOS
          </button>
        ) : (
          <button type="button" className={given ? "btn btn--wide" : "btn btn--wide btn--primary"} onClick={() => void act({ type: "hand", tab: tab.id, give: !given })}>
            {given ? "Take this tab back" : "Give this tab to KOS"}
          </button>
        )}
      </div>
    </Section>
  );
}

function KosSection({ state, act }: { state: PopupState; act: Act }): ReactElement {
  const [open, setOpen] = useState<string>();
  const [adding, setAdding] = useState(false);
  const pairing = !state.kos.length || adding;
  return (
    <Section
      label={state.kos.length > 1 ? `KOS · ${state.kos.length}` : "KOS"}
      action={
        <AnimatePresence initial={false}>
          {state.kos.length > 0 && !adding && (
            <m.button key="add" type="button" className="btn btn--ghost btn--sm btn--icon" title="Pair this Chrome with another KOS as well, say one at work beside one at home." onClick={() => setAdding(true)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <PlusIcon size={11} title="" />
              Add a KOS
            </m.button>
          )}
        </AnimatePresence>
      }
    >
      <AnimatePresence mode="popLayout" initial={false}>
        {state.kos.map((k) => (
          <m.div key={k.id} layout variants={arrive} initial="hidden" animate="show" exit="hidden">
            <KosCard k={k} open={open === k.id} toggle={() => setOpen(open === k.id ? undefined : k.id)} act={act} />
          </m.div>
        ))}
        {pairing && (
          <m.div key="pair" layout variants={arrive} initial="hidden" animate="show" exit="hidden">
            <PairForm first={!state.kos.length} cancel={() => setAdding(false)} act={act} />
          </m.div>
        )}
      </AnimatePresence>
    </Section>
  );
}

function KosCard({ k, open, toggle, act }: { k: KosState; open: boolean; toggle: () => void; act: Act }): ReactElement {
  const [armed, setArmed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3_000);
    return () => clearTimeout(t);
  }, [armed]);
  const [pairing, setPairing] = useState(false);
  const link = linkWords(k);
  const on = connected(k);
  // Why it is not connected, under the row with what puts it right; nothing while it is on or on its way.
  const trouble = !on && (k.held || k.link !== "connecting");
  return (
    <div className="card">
      <DrawerRow wrap icon={<ServerIcon />} tone={link.tone} title={k.host} detail={asWords(k)} open={open} onToggle={toggle} trailing={<StatePill tone={link.tone} word={link.word} />} />
      {trouble && (
        <div className="kos-reason">
          <p title={link.detail}>{link.detail}</p>
          {!pairing && (
            <div className="row row--start">
              {needsPairing(k) ? (
                <button type="button" className="btn btn--primary btn--sm" onClick={() => setPairing(true)}>
                  Pair again
                </button>
              ) : k.held ? (
                <button type="button" className="btn btn--primary btn--sm" onClick={() => void act({ type: "connect", id: k.id })}>
                  Connect
                </button>
              ) : (
                <button type="button" className="btn btn--sm" onClick={() => void act({ type: "connect", id: k.id })}>
                  Try now
                </button>
              )}
            </div>
          )}
        </div>
      )}
      <Collapse open={pairing}>
        <PairForm again={k} cancel={() => setPairing(false)} act={act} />
      </Collapse>
      <Collapse open={open}>
        <hr className="rule" />
        <div className="setting">
          <div className="line-text line-text--wrap">
            <strong>Ask before each session</strong>
            <span>{k.askFirst ? "This KOS asks here, with the task and how long, every time." : "Off: this KOS's approval queue decides instead. The border and Stop still show."}</span>
          </div>
          <Switch on={k.askFirst} label="Ask before each session" onChange={(next) => (next ? void act({ type: "askFirst", id: k.id, on: true }) : setConfirming(true))} />
        </div>
        <Collapse open={confirming}>
          <div className="confirm">
            <p className="hint">Let {k.host} start sessions in this Chrome without asking here? Its approval queue decides instead, for when you are away; the border and Stop still show.</p>
            <div className="row">
              <button type="button" className="btn btn--ghost" onClick={() => setConfirming(false)}>
                Keep asking
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => {
                  setConfirming(false);
                  void act({ type: "askFirst", id: k.id, on: false });
                }}
              >
                Stop asking here
              </button>
            </div>
          </div>
        </Collapse>
        <div className="row row--start">
          <button type="button" className={k.held ? "btn btn--primary" : "btn btn--ghost"} onClick={() => void act({ type: k.held ? "connect" : "disconnect", id: k.id })} title={k.held ? undefined : "This KOS sees this Chrome offline until you connect again; the pairing stays."}>
            {k.held ? "Connect" : "Disconnect"}
          </button>
        </div>
        <div className="row">
          <a className="link grow" href={k.url} target="_blank" rel="noopener">
            Dashboard
          </a>
          <button
            type="button"
            className="btn btn--danger"
            title="This KOS forgets this Chrome too. Any other KOS stays paired."
            onClick={() => {
              if (!armed) return setArmed(true);
              setArmed(false);
              void act({ type: "unpair", id: k.id });
            }}
          >
            {armed ? "Press again" : "Unpair"}
          </button>
        </div>
      </Collapse>
    </div>
  );
}

/**
 * Pairing, as KOS for Mac asks for it: the KOS's address and its code, or the
 * pairing link pasted whole, which fills both in; this Chrome's name beside
 * the code; a line saying how it is going beside the buttons. `again` is a
 * pairing KOS no longer takes, paired anew in its own card: its address and
 * name filled in, and the new pairing in its place.
 */
function PairForm({ first = false, again, cancel, act }: { first?: boolean; again?: KosState; cancel: () => void; act: Act }): ReactElement {
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? "";
  const [address, setAddress] = useState(again?.url ?? "");
  const [code, setCode] = useState("");
  const [name, setName] = useState(again?.name ?? `Chrome${platform ? ` on ${platform}` : ""}`);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; failed?: boolean }>();
  // Another KOS to add: the form, wherever it falls on the page, brought up on the spring as KOS for Mac's is, its address ready to type.
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (first || again) return;
    form.current?.querySelector("input")?.focus({ preventScroll: true });
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    form.current?.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" });
  }, [first, again]);
  /** What was typed or pasted in a field; a pairing link, in either, fills in both. */
  const read = (text: string, set: (text: string) => void): void => {
    if (text.trim().startsWith("kos-device:")) {
      try {
        const link = parsePairing(text);
        setAddress(link.url);
        setCode(link.code);
        return setNote({ text: "Check this is your KOS, then press Pair." });
      } catch (err) {
        setNote({ text: err instanceof Error ? err.message : String(err), failed: true });
      }
    }
    set(text);
  };
  // That KOS's Devices page, once the address reads as one, where its pairing code is made.
  const devices = ((): string | undefined => {
    try {
      return address.trim() ? `${kosAddress(address)}/#/settings/devices` : undefined;
    } catch {
      return undefined;
    }
  })();
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    void (async () => {
      let url: string;
      try {
        url = kosAddress(address);
      } catch (err) {
        return setNote({ text: err instanceof Error ? err.message : String(err), failed: true });
      }
      setBusy(true);
      setNote({ text: `Pairing with ${new URL(url).host}…` });
      if (await act({ type: "pair", url, code: code.trim().toUpperCase(), name: name.trim() })) cancel();
      else setNote(undefined);
      setBusy(false);
    })();
  };
  return (
    <form ref={form} className={again ? "pair-form pair-form--again" : "card pair-form"} onSubmit={submit}>
      <strong>{again ? `Pair again with ${again.host}` : first ? "Pair with your KOS" : "Pair with another KOS"}</strong>
      <div className="hint-row">
        <p className="hint">
          {again
            ? "From that KOS: Settings, Devices, Add a device. Paste its link or its code here; this pairing takes the old one's place."
            : first
              ? "From KOS: Settings, Devices, Add a device. Paste its link here."
              : "From that KOS: Settings, Devices, Add a device. Pairing one already here replaces it."}
        </p>
        {devices && (
          <a className="link" href={devices} target="_blank" rel="noreferrer">
            Devices
          </a>
        )}
      </div>
      <Field label="KOS address or pairing link">
        <input className="mono" type="text" placeholder="https://kos.example.ts.net" spellCheck={false} autoComplete="off" value={address} onChange={(e) => read(e.target.value, setAddress)} />
      </Field>
      <div className="pair-fields">
        <Field label="Code">
          <input className="mono" type="text" placeholder="K7QX-M2PA" spellCheck={false} autoComplete="off" value={code} onChange={(e) => read(e.target.value, setCode)} />
        </Field>
        <Field label="This Chrome's name in KOS">
          <input type="text" placeholder="Chrome on macOS" spellCheck={false} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      </div>
      <div className="row">
        <span className={note?.failed ? "pair-note error" : "pair-note"}>{note?.text}</span>
        {!first && (
          <button type="button" className="btn btn--ghost" onClick={cancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="btn btn--primary" disabled={busy || !address.trim() || !code.trim()}>
          Pair
        </button>
      </div>
    </form>
  );
}

function HiddenSection({ state, tab, act }: { state: PopupState; tab: chrome.tabs.Tab | undefined; act: Act }): ReactElement {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const sites = state.settings.hiddenSites;
  const summary = open
    ? "Never opened, acted on or reported to KOS, with every subdomain."
    : !sites.length
      ? "Nothing yet. Add a site and KOS never sees it."
      : sites.length <= 2
        ? sites.join(" and ")
        : `${sites[0]}, ${sites[1]} and ${sites.length - 2} more`;
  const here = tab?.url && /^https?:\/\//.test(tab.url) && !isHidden(tab.url, sites) ? siteOf(tab.url) : undefined;
  return (
    <Section label="On this Chrome">
      <div className="card">
        <DrawerRow wrap icon={<HiddenIcon />} tone="accent" title="Hidden from KOS" detail={summary} open={open} onToggle={() => setOpen(!open)} />
        <Collapse open={open}>
          <hr className="rule" />
          <m.div className="tags" layout>
            <AnimatePresence initial={false}>
              {sites.map((site) => (
                <m.span key={site} layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  <Tag remove={{ label: `Show ${site} to KOS`, onRemove: () => void act({ type: "unhide", site }) }}>{site}</Tag>
                </m.span>
              ))}
            </AnimatePresence>
          </m.div>
          <form
            className="add-site"
            onSubmit={(e) => {
              e.preventDefault();
              void act({ type: "hide", site: typed }).then((ok) => ok && setTyped(""));
            }}
          >
            <input type="text" placeholder="example.com" spellCheck={false} autoComplete="off" aria-label="A site to hide" value={typed} onChange={(e) => setTyped(e.target.value)} />
            <button type="submit" className="btn">
              Hide
            </button>
          </form>
          {here && (
            <div className="row">
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => void act({ type: "hide", site: here })}>
                Hide {here}
              </button>
            </div>
          )}
        </Collapse>
        <hr className="rule" />
        <div className="foot">
          <HandIcon size={13} />
          <div className="foot-text">
            <span>KOS works only in its own window and the tabs you give it. Click or type in one of them and it pauses at once.</span>
            <a className="link" href={SAFETY} target="_blank" rel="noopener">
              How this keeps your Chrome safe
            </a>
          </div>
        </div>
      </div>
    </Section>
  );
}

// The settings page.

function SettingsPage({ state, act, back }: { state: PopupState; act: Act; back: () => void }): ReactElement {
  const s = state.settings;
  const set = (patch: Record<string, unknown>): void => void act({ type: "settings", patch });
  const takeover: [Takeover, string][] = [
    ["anyInput", "Clicks, keys, scrolling"],
    ["clicksAndKeys", "Clicks and keys"],
  ];
  const themes: [ThemeChoice, string][] = [
    ["dashboard", "Same as dashboard"],
    ["light", "Light"],
    ["dark", "Dark"],
    ["system", "System"],
  ];
  return (
    <div className="stack">
      <div className="page-head">
        <IconButton label="Back" onClick={back}>
          <ChevronLeft size={14} title="" />
        </IconButton>
        <strong>Settings</strong>
      </div>
      <Section label="Sessions">
        <div className="card">
          <Setting title="Longest session" detail="KOS may ask for longer; it gets this at most.">
            <Chips options={CHOICES.longestMinutes.map((v) => [v, minutesWords(v)])} selected={s.longestMinutes} onChoose={(v) => set({ longestMinutes: v })} />
          </Setting>
          <hr className="rule" />
          <Setting title="Wait for an answer" detail="Then the ask says no by itself, so a Chrome nobody is at says no.">
            <Chips options={CHOICES.promptWaitSeconds.map((v) => [v, v < 60 ? `${v} s` : minutesWords(v / 60)])} selected={s.promptWaitSeconds} onChoose={(v) => set({ promptWaitSeconds: v })} />
          </Setting>
          <hr className="rule" />
          <Setting title="End when idle for" detail="A session KOS has stopped using gives Chrome back on its own.">
            <Chips options={CHOICES.idleMinutes.map((v) => [v, minutesWords(v)])} selected={s.idleMinutes} onChoose={(v) => set({ idleMinutes: v })} />
          </Setting>
        </div>
      </Section>
      <Section label="While KOS works">
        <div className="card">
          <Setting title="What pauses KOS" detail={s.takeover === "anyInput" ? "Your click, key or scroll in a KOS tab pauses it at once." : "Only a click or a key; you can scroll a KOS tab freely."}>
            <Chips options={takeover} selected={s.takeover} onChoose={(v) => set({ takeover: v })} />
          </Setting>
        </div>
      </Section>
      <Section label="Appearance">
        <div className="card">
          <Setting title="Theme" detail={themeWords(s.theme, state.dashboardTheme)}>
            <Chips options={themes} selected={s.theme} onChoose={(v) => set({ theme: v })} />
          </Setting>
        </div>
      </Section>
      <Section label="App">
        <div className="card">
          <Toggle title="Connect when Chrome opens" detail={s.connectOnStart ? "Each KOS can reach this Chrome as soon as it opens." : "Off: each waits for Connect, so KOS cannot reach this Chrome until you say."} on={s.connectOnStart} set={(on) => set({ connectOnStart: on })} />
          <hr className="rule" />
          <Toggle title="Time left on the KOS icon" detail={s.timeOnIcon ? "The icon counts down while a session runs." : "Off: the icon says ON while a session runs."} on={s.timeOnIcon} set={(on) => set({ timeOnIcon: on })} />
        </div>
      </Section>
      <Section label="Diagnostics">
        <div className="card">
          <LogRow />
        </div>
      </Section>
    </div>
  );
}

/** What a theme choice draws, said under it. */
function themeWords(choice: ThemeChoice, dashboard: PopupState["dashboardTheme"]): string {
  const system = "follows this computer's appearance";
  if (choice === "light" || choice === "dark") return `${choice === "light" ? "Light" : "Dark"} here, whatever the dashboard is set to.`;
  if (choice === "system") return `This Chrome's own: ${system}.`;
  if (!dashboard) return `The dashboard's theme, once KOS has said it; until then, ${system}.`;
  const drawn = dashboard.drawn ?? (dashboard.mode === "system" ? undefined : dashboard.mode);
  return drawn ? `As the dashboard looks, now ${drawn === "light" ? "Light" : "Dark"}.` : `The dashboard's theme, System: ${system}.`;
}

function Setting({ title, detail, children }: { title: string; detail: string; children: ReactElement }): ReactElement {
  return (
    <div className="setting setting--stacked">
      <div className="line-text line-text--wrap">
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      {children}
    </div>
  );
}

function Toggle({ title, detail, on, set }: { title: string; detail: string; on: boolean; set: (on: boolean) => void }): ReactElement {
  return (
    <div className="setting">
      <div className="line-text line-text--wrap">
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      <Switch on={on} label={title} onChange={set} />
    </div>
  );
}

function LogRow(): ReactElement {
  const [copied, setCopied] = useState(false);
  return (
    <div className="setting">
      <div className="line-text line-text--wrap">
        <strong>Log</strong>
        <span>Each KOS's line and every session, since Chrome opened. Tasks are kept out. Copy it to send when something went wrong.</span>
      </div>
      <button
        type="button"
        className="btn"
        onClick={() =>
          void (async () => {
            await navigator.clipboard.writeText(await ask<string>({ type: "log" }));
            setCopied(true);
            setTimeout(() => setCopied(false), 2_000);
          })()
        }
      >
        {copied ? "Copied" : "Copy log"}
      </button>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <LazyMotion features={domMax} strict>
    {/* The one spring KOS for Mac moves by, for anything not told otherwise: a section making room, a page. */}
    <MotionConfig reducedMotion="user" transition={spring}>
      <Popup />
    </MotionConfig>
  </LazyMotion>,
);
