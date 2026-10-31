import type { BlobMood } from "@kos/shared/blobmotion";
import { AnimatePresence, LazyMotion, MotionConfig, domMax, m } from "motion/react";
import { useCallback, useEffect, useState, type FormEvent, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

import { parsePairing } from "./address.js";
import { CHOICES, isHidden, siteOf, type Takeover } from "./settings.js";
import { Chips, Collapse, DrawerRow, Face, ICONS, Icon, Pill, Section, Switch, ask, minutesLeft, minutesWords, rise, spring, stagger, type Tone } from "./ui/kit.js";
import type { KosState, PopupState } from "./worker.js";

/**
 * The popup under the KOS icon, laid out as KOS Device's window is and
 * moving as the dashboard does: KOS's face and where it stands; the live
 * session; this tab, to give or take back; each KOS folded to a line,
 * opening to its rules and its line; the sites hidden from KOS; and behind
 * the gear, the owner's settings for this Chrome. It reads the worker's
 * state and asks the worker for every change.
 */

const LINK: Record<string, { word: string; tone: Tone }> = {
  online: { word: "Connected", tone: "ok" },
  connecting: { word: "Connecting", tone: "accent" },
  offline: { word: "Offline", tone: "warn" },
  refused: { word: "Not connected", tone: "danger" },
};
const linkOf = (k: KosState): { word: string; tone: Tone } => (k.held ? { word: "Disconnected", tone: "muted" } : (LINK[k.link] ?? { word: k.link, tone: "muted" }));
const connected = (k: KosState): boolean => k.link === "online" && !k.held;

function mood(s: PopupState | undefined): BlobMood {
  if (!s || !s.kos.length) return "idle";
  if (s.session) return s.session.paused ? "idle" : "working";
  if (s.kos.some(connected)) return "idle";
  return s.kos.every((k) => k.held) ? "asleep" : "error";
}

/** The page's whole state: the worker's, the tab in front, and an error to show. */
function usePopup(): { state: PopupState | undefined; tab: chrome.tabs.Tab | undefined; error: string; act: (message: Record<string, unknown>) => Promise<boolean> } {
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
  return { state, tab, error, act };
}

function Popup(): ReactElement {
  const { state, tab, error, act } = usePopup();
  const [page, setPage] = useState<"home" | "settings">("home");
  const live = state?.session && !state.session.paused;
  const best = state?.kos.find(connected) ?? state?.kos[0];
  const pill: { word: string; tone: Tone } = !state?.kos.length
    ? { word: "Not paired", tone: "muted" }
    : live
      ? { word: "In use", tone: "accent" }
      : best && connected(best)
        ? { word: "Ready", tone: "ok" }
        : best
          ? linkOf(best)
          : { word: "Not paired", tone: "muted" };
  return (
    <>
      <header className="head">
        <Face size={36} mood={mood(state)} />
        <div className="head-text">
          <strong>KOS</strong>
          <span className="sub">Only when you allow.</span>
        </div>
        <Pill tone={pill.tone}>{pill.word}</Pill>
        <AnimatePresence initial={false}>
          {page === "home" && (
            <m.button key="gear" type="button" className="icon-btn" aria-label="Settings" title="Settings" onClick={() => setPage("settings")} initial={{ opacity: 0, rotate: -60 }} animate={{ opacity: 1, rotate: 0 }} exit={{ opacity: 0, rotate: 60 }} transition={spring}>
              <Icon path={ICONS.gear} size={14} />
            </m.button>
          )}
        </AnimatePresence>
      </header>
      {state && (
        <AnimatePresence mode="wait" initial={false}>
          {page === "home" ? (
            <m.main key="home" className="stack page" initial={{ opacity: 0, x: -18 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -18 }} transition={spring}>
              <Home state={state} tab={tab} act={act} />
            </m.main>
          ) : (
            <m.main key="settings" className="stack page" initial={{ opacity: 0, x: 18 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 18 }} transition={spring}>
              <SettingsPage state={state} act={act} back={() => setPage("home")} />
            </m.main>
          )}
        </AnimatePresence>
      )}
      <AnimatePresence>
        {error && (
          <m.p className="error" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            {error}
          </m.p>
        )}
      </AnimatePresence>
    </>
  );
}

type Act = (message: Record<string, unknown>) => Promise<boolean>;

// The home page.

function Home({ state, tab, act }: { state: PopupState; tab: chrome.tabs.Tab | undefined; act: Act }): ReactElement {
  return (
    <m.div className="stack" variants={stagger} initial="hidden" animate="show">
      <AnimatePresence initial={false}>{state.session && <SessionCard key="session" session={state.session} act={act} />}</AnimatePresence>
      {state.kos.length > 0 && <ThisTab state={state} tab={tab} act={act} />}
      <KosSection state={state} act={act} />
      <HiddenSection state={state} tab={tab} act={act} />
      <m.p className="foot" variants={rise}>
        <Icon path={ICONS.hand} size={13} />
        <span>KOS works only in its own window and the tabs you give it. Click or type in one of them and it pauses.</span>
      </m.p>
    </m.div>
  );
}

function SessionCard({ session, act }: { session: NonNullable<PopupState["session"]>; act: Act }): ReactElement {
  return (
    <m.section className="card live" data-paused={session.paused || undefined} layout variants={rise} initial="hidden" animate="show" exit="exit">
      <div className="live-head">
        <strong>{session.paused ? "Paused. You have control." : "KOS is using this Chrome"}</strong>
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
          <span className="tile">{tab.favIconUrl ? <img src={tab.favIconUrl} alt="" /> : <Icon path={ICONS.globe} />}</span>
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
        state.kos.length > 0 && !adding ? (
          <button type="button" className="btn btn--ghost btn--sm" title="Pair this Chrome with another KOS as well, say one at work beside one at home." onClick={() => setAdding(true)}>
            + Add a KOS
          </button>
        ) : undefined
      }
    >
      <AnimatePresence initial={false}>
        {state.kos.map((k) => (
          <m.div key={k.id} layout variants={rise} initial="hidden" animate="show" exit="exit" transition={spring}>
            <KosCard k={k} open={open === k.id} toggle={() => setOpen(open === k.id ? undefined : k.id)} act={act} />
          </m.div>
        ))}
        {pairing && (
          <m.div key="pair" layout variants={rise} initial="hidden" animate="show" exit="exit">
            <PairCard first={!state.kos.length} cancel={() => setAdding(false)} act={act} />
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
  const link = linkOf(k);
  const on = connected(k);
  const summary = on ? `As ${k.name} · ${k.askFirst ? "asks here first" : "its approvals decide"}` : k.held ? "Not connected. The pairing stays." : (k.detail ?? `${link.word}.`);
  return (
    <div className="card">
      <DrawerRow icon={<Icon path={ICONS.server} />} tone={on ? "ok" : link.tone} title={k.host} detail={summary} open={open} onToggle={toggle} trailing={on ? undefined : <Pill tone={link.tone}>{link.word}</Pill>} />
      <Collapse open={open}>
        <hr className="rule" />
        <div className="setting">
          <div className="setting-text">
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
          {!k.held && (k.link === "offline" || k.link === "refused") && (
            <button type="button" className="btn" onClick={() => void act({ type: "connect", id: k.id })}>
              Reconnect
            </button>
          )}
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

function PairCard({ first, cancel, act }: { first: boolean; cancel: () => void; act: Act }): ReactElement {
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? "";
  const [link, setLink] = useState("");
  const [name, setName] = useState(`Chrome${platform ? ` on ${platform}` : ""}`);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    void (async () => {
      setProblem("");
      try {
        parsePairing(link);
      } catch (err) {
        return setProblem(err instanceof Error ? err.message : String(err));
      }
      setBusy(true);
      if (await act({ type: "pair", link, name: name.trim() })) cancel();
      setBusy(false);
    })();
  };
  return (
    <form className="card" onSubmit={submit}>
      <strong>{first ? "Pair with your KOS" : "Pair with another KOS"}</strong>
      <p className="hint">{first ? "In KOS: Settings, Devices, Add a device. Paste its link here." : "From that KOS: Settings, Devices, Add a device. Pairing one already here replaces it."}</p>
      <label className="field">
        <span>Pairing link</span>
        <input className="mono" type="text" placeholder="kos-device://pair?url=…&code=…" spellCheck={false} autoComplete="off" required value={link} onChange={(e) => setLink(e.target.value)} autoFocus={!first} />
      </label>
      <label className="field">
        <span>This Chrome's name in KOS</span>
        <input type="text" placeholder="Chrome on macOS" spellCheck={false} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      {problem && <p className="error">{problem}</p>}
      <div className="row">
        {!first && (
          <button type="button" className="btn btn--ghost" onClick={cancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="btn btn--primary" disabled={busy}>
          {busy ? "Pairing…" : "Pair"}
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
        <DrawerRow icon={<Icon path={ICONS.hidden} />} tone="accent" title="Hidden from KOS" detail={summary} open={open} onToggle={() => setOpen(!open)} />
        <Collapse open={open}>
          <hr className="rule" />
          <m.div className="site-chips" layout>
            <AnimatePresence initial={false}>
              {sites.map((site) => (
                <m.span key={site} className="site-chip" layout initial={{ opacity: 0, scale: 0.85 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.85 }} transition={spring}>
                  {site}
                  <button type="button" aria-label={`Show ${site} to KOS`} title={`Show ${site} to KOS`} onClick={() => void act({ type: "unhide", site })}>
                    ×
                  </button>
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
  return (
    <m.div className="stack" variants={stagger} initial="hidden" animate="show">
      <m.div className="page-head" variants={rise}>
        <button type="button" className="icon-btn" aria-label="Back" title="Back" onClick={back}>
          <Icon path={ICONS.back} size={14} />
        </button>
        <strong>Settings</strong>
      </m.div>
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
    </m.div>
  );
}

function Setting({ title, detail, children }: { title: string; detail: string; children: ReactElement }): ReactElement {
  return (
    <div className="setting setting--stacked">
      <div className="setting-text">
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
      <div className="setting-text">
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
      <div className="setting-text">
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
    <MotionConfig reducedMotion="user">
      <Popup />
    </MotionConfig>
  </LazyMotion>,
);
