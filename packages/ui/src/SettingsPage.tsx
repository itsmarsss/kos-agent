import { m } from "motion/react";
import { marksOfLetters } from "@kos/shared";
import { CloseIcon, ease, EmptyState, Field, IconButton, KOS_SEED, Marked, Pill, RefChip, SearchField, SheetFoot, Switch, Tag, useOverlayScroll } from "@kos/kit";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode } from "react";

import {
  api,
  type Behaviour,
  type ModelRate,
  type SettingsPayload, type ModuleInfo, type SkillInfo, type McpServerInfo, type PermissionRule, type BrowserSettings, type RestartState, type Status } from "./api.js";
import type { FaceLook } from "./api.js";
import { FaceEditor } from "./FaceEditor.js";
import { ModelSettings } from "./ModelSettings.js";
import { PageHead } from "./PageHead.js";
import { useEdgeFade } from "./edgefade.js";
import { FieldRow } from "./kit.js";
import { useOpenTab } from "./opentab.js";
import { hrefFor } from "./routes.js";
import { Select } from "./Select.js";
import { DashboardTokenField } from "./TokenGate.js";
import { matchesSkillView, skillViews } from "./skillviews.js";
import { McpAdd, SkillsAdd } from "./ExtensionBrowser.js";
import { chooseTheme, isDensity, isTheme, readDensity, setDensity, useTheme, type Density } from "./theme.js";
import { SpendPanel } from "./SpendPanel.js";
import { DevicesPanel } from "./DevicesPanel.js";
import { GROUPS, SECTIONS, SETTINGS, isSettingsSection, searchSettings, type SettingEntry, type SettingHit, type SettingsSection } from "./settingsindex.js";

/**
 * Everything you would otherwise have opened a dotfile to change.
 *
 * Grouped and reachable rather than stacked: a settings page you have to
 * scroll to the bottom of to find out what is on it is one you avoid. The rail
 * says what exists, each section holds one subject, and each saves on its own
 * so nothing is half-applied.
 *
 * Keys are write-only from here. What comes back is whether one is set and its
 * last four characters, which is enough to tell two apart and no use to
 * anyone; the value itself never leaves the machine it is stored on.
 */

/**
 * What the fields show before the server has answered. The same numbers the
 * harness defaults to, so an unread settings page is not also a wrong one.
 */
const BEHAVIOUR_FALLBACK: Behaviour = {
  engine: "api",
  autoFix: false,
  maxSteps: 10,
  screenSteps: 40,
  fixSteps: 24,
  selfPromptsPerHour: 10,
  agentMinutes: 15,
  agentTurns: 60,
  stallMinutes: 3,
  approvalMinutes: 30,
  approvalExpiryHours: 24,
  heartbeatMinutes: 0,
  memoryExtraction: false,
  smartContext: true,
  extractEveryChars: 6000,
  memoryDecideAbove: 80,
};

/**
 * Also a save key, not only a nav section: two independent saves can live on
 * one tab, and each needs its own busy and saved state.
 */
type SectionId = SettingsSection | "engine";


/**
 * A bounded number. Typed or nudged, and never outside its range: these
 * govern spend and runaway loops, so the field itself should not be able to
 * express "loop for a day".
 */
function Limit({
  label,
  hint,
  value,
  range,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  range?: [number, number];
  onChange: (value: number) => void;
}): ReactElement {
  const [min, max] = range ?? [1, 1000];
  return (
    <Field group className="set-field" label={label} hint={`${hint} Between ${min} and ${max}.`}>
      <input
        className="kos-input set-limit"
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (Number.isFinite(next)) {
            onChange(Math.min(max, Math.max(min, Math.round(next))));
          }
        }}
      />
    </Field>
  );
}

/**
 * A list of short strings, edited one at a time: hostnames, folders.
 * Shown as what it is, whatever the file stores it as.
 */
function TokenList({
  items,
  onChange,
  placeholder,
  action,
  clean = (s) => s.trim(),
  empty,
}: {
  items: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  /** The verb on the button. */
  action: string;
  /** What was typed, as it is kept; empty to refuse it. */
  clean?: (typed: string) => string;
  /** Said under the list when there is nothing in it. */
  empty?: string;
}): ReactElement {
  const [draft, setDraft] = useState("");

  const add = (): void => {
    const cleaned = clean(draft);
    if (!cleaned || items.includes(cleaned)) {
      setDraft("");
      return;
    }
    onChange([...items, cleaned]);
    setDraft("");
  };

  return (
    <div className="hostlist">
      {items.length > 0 && (
        <ul className="hostlist-items">
          {items.map((h) => (
            <li key={h}>
              <span className="ops-mono">{h}</span>
              <IconButton tone="bare"
                label={`Remove ${h}`}
                onClick={() => onChange(items.filter((x) => x !== h))}
              >
                <CloseIcon size={12} title="" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <div className="hostlist-add">
        <input
          className="kos-input"
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button
          type="button"
          className="btn"
          disabled={!draft.trim()}
          onClick={add}
        >
          {action}
        </button>
      </div>
      {items.length === 0 && empty && <span className="hint">{empty}</span>}
    </div>
  );
}

/**
 * A set of hostnames, edited one at a time.
 *
 * Stored as the comma-separated string the environment file wants, because
 * that is what the host reads; shown as what it is.
 */
function HostList({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}): ReactElement {
  const hosts = value
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  return (
    <TokenList
      items={hosts}
      onChange={(next) => onChange(next.join(", "))}
      placeholder="rss.nytimes.com"
      action="Allow"
      // Typed with a scheme or a path, which is the natural thing to paste.
      clean={(typed) =>
        typed
          .trim()
          .replace(/^[a-z]+:\/\//i, "")
          .replace(/\/.*$/, "")
          .toLowerCase()
      }
      empty="Nothing is listed, so every fetch asks you first."
    />
  );
}

function Section({
  title,
  blurb,
  children,
  onSave,
  saving,
  saved,
  canSave,
  extra,
}: {
  title: string;
  blurb: string;
  children: ReactNode;
  onSave?: () => void;
  saving?: boolean;
  saved?: string | null;
  /** Withhold Save until something has changed. Undefined means always on. */
  canSave?: boolean;
  /** Another action beside Save, in the same footer as every other tab. */
  extra?: ReactNode;
}): ReactElement {
  return (
    <section className="set-section">
      <PageHead title={title} subtitle={blurb} />
      <div className="set-card">
        <div className="set-card-body" onKeyDown={onSave && canSave !== false && !saving ? (e) => enterSaves(e, onSave) : undefined}>
          {children}
        </div>
        {onSave && (
          <SheetFoot
            note={saved && <span className={`set-saved ${saved === "Not saved yet" ? "is-unsaved" : ""}`}>{saved}</span>}
            primary={
              <>
                {extra}
                <button type="button" className="btn btn--primary" disabled={saving || canSave === false} onClick={onSave}>
                  {saving ? "Saving…" : "Save"}
                </button>
              </>
            }
          />
        )}
      </div>
    </section>
  );
}

/**
 * Enter in a one-line field saves the card, as it would submit a form: the
 * card is not a form, since some hold forms of their own. A field in one of
 * those, a search, a box that takes Enter itself, or text still being
 * composed is left alone.
 */
export function enterSaves(e: ReactKeyboardEvent<HTMLElement>, save: () => void): void {
  const t = e.target;
  if (e.key !== "Enter" || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || e.nativeEvent.isComposing) return;
  if (!(t instanceof HTMLInputElement) || t.closest("form") || e.defaultPrevented) return;
  if (["search", "checkbox", "radio", "button", "submit", "file", "range", "color"].includes(t.type)) return;
  e.preventDefault();
  save();
}

/** The zones this machine knows, so a typo cannot break every schedule. */
function timezones(): string[] {
  const supported = (
    Intl as unknown as { supportedValuesOf?: (k: string) => string[] }
  ).supportedValuesOf;
  try {
    return supported?.("timeZone") ?? [];
  } catch {
    return [];
  }
}

/** Where a rule the owner states lives: Memory for every chat, a chat's Brief for one. */
export const STANDING_RULES_HINT = "A rule for every chat, such as “never message me after 10pm”, is kept in Memory: say it in any chat, or add it there and pin it so every chat reads it. A rule for one chat goes in that chat's Brief.";

export function SettingsPage({
  section,
  onSection,
}: {
  /** The section the hash names, so a link can land on one. */
  section?: string;
  onSection?: (section: SectionId) => void;
} = {}): ReactElement {
  const [data, setData] = useState<SettingsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActiveState] = useState<SectionId>(isSettingsSection(section) ? section : "you");
  const theme = useTheme();
  const [themeNote, setThemeNote] = useState<string | null>(null);
  /** KOS's face, from the workspace; saved as it is changed. */
  const [kosFace, setKosFace] = useState<FaceLook>({});
  const [kosFaceNote, setKosFaceNote] = useState<string | null>(null);
  useEffect(() => {
    void api.kosFace().then((r) => setKosFace(r.face)).catch(() => undefined);
  }, []);
  const saveKosFace = async (face: FaceLook): Promise<void> => {
    setKosFace(face);
    try {
      await api.saveKosFace(face);
      setKosFaceNote("Saved. The sidebar and the tab icon follow within a few seconds.");
    } catch (err) {
      setKosFaceNote(err instanceof Error ? err.message : String(err));
    }
  };
  const [density, setDensityState] = useState<Density>(readDensity);
  useEffect(() => {
    if (isSettingsSection(section)) setActiveState(section);
  }, [section]);
  const setActive = (id: SectionId): void => {
    setActiveState(id);
    onSection?.(id);
  };
  /** The search over every setting, and the one it last sent you to, to show. */
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState(0);
  const [found, setFound] = useState<{ label?: string; n: number } | null>(null);
  // On a phone the rail is a strip that scrolls sideways: it fades where there is more.
  const sideFade = useEdgeFade<HTMLDivElement>(".set-rail", "x", data !== null && data !== undefined);
  const paneRef = useRef<HTMLDivElement>(null);
  const paneScroll = useOverlayScroll(paneRef);
  const railRef = useRef<HTMLElement>(null);
  const railScroll = useOverlayScroll(railRef);
  // On a phone the rail is a strip that scrolls sideways: keep the open section in sight on it.
  const loaded = data !== null;
  // On a wider window the rail scrolls up and down under the search: a section
  // a search sent you to is brought fully into it, not left cut off at its top.
  useEffect(() => {
    const rail = railRef.current;
    const on = rail?.querySelector<HTMLElement>(".set-rail-item.is-on");
    if (!rail || !on) return;
    if (rail.scrollWidth > rail.clientWidth) {
      rail.scrollTo({ left: Math.max(0, on.offsetLeft - (rail.clientWidth - on.offsetWidth) / 2), behavior: "auto" });
      return;
    }
    const top = on.getBoundingClientRect().top - rail.getBoundingClientRect().top;
    const room = 8;
    if (top < room) rail.scrollTop += top - room;
    else if (top + on.offsetHeight > rail.clientHeight - room) rail.scrollTop += top + on.offsetHeight - rail.clientHeight + room;
  }, [active, loaded]);
  // The focus goes with you: to the setting found, or to a section's first control.
  const jump = (hit: SettingHit): void => {
    setActive(hit.section);
    setQuery("");
    setFound({ ...(hit.label ? { label: hit.label } : {}), n: Date.now() });
  };
  // A new section opens at its top; one a search sent you to, at the setting.
  useEffect(() => {
    if (!found && paneRef.current) paneRef.current.scrollTop = 0;
  }, [active, found]);
  useEffect(() => {
    if (!found) return;
    let tries = 0;
    let timer = 0;
    // The section may still be loading what the setting sits in; look again for a moment.
    const look = (): void => {
      const pane = paneRef.current;
      const label = found.label;
      if (label === undefined) {
        const first = pane?.querySelector<HTMLElement>(".set-pane :is(input, select, textarea, button):not([disabled])");
        if (!first) {
          if (tries++ < 20) timer = window.setTimeout(look, 100);
          return;
        }
        if (pane) pane.scrollTop = 0;
        first.focus({ preventScroll: true });
        return;
      }
      const target =
        pane?.querySelector<HTMLElement>(`[data-field="${CSS.escape(label)}"]`) ??
        [...(pane?.querySelectorAll<HTMLElement>("h3") ?? [])].find((h) => h.textContent?.trim() === label);
      if (!target) {
        if (tries++ < 20) timer = window.setTimeout(look, 100);
        return;
      }
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      target.classList.remove("is-found");
      void target.offsetWidth;
      target.classList.add("is-found");
      target.querySelector<HTMLElement>("input, select, textarea, button")?.focus({ preventScroll: true });
    };
    timer = window.setTimeout(look, 60);
    return () => window.clearTimeout(timer);
  }, [found]);
  const [how, setHow] = useState<Behaviour>(BEHAVIOUR_FALLBACK);
  /** The last values the server confirmed, so an edit can be seen as one. */
  const [savedHow, setSavedHow] = useState<Behaviour>(BEHAVIOUR_FALLBACK);
  const [defaults, setDefaults] = useState<Behaviour>(BEHAVIOUR_FALLBACK);
  const [limits, setLimits] = useState<Record<string, [number, number]>>({});
  /** ModelSettings owns its draft, so it hands its save up to the footer. */
  const saveModels = useRef<(() => void) | null>(null);
  /** ModelSettings owns its draft, so it reports whether that draft differs. */
  const [modelsDirty, setModelsDirty] = useState(false);
  const [busy, setBusy] = useState<SectionId | null>(null);
  const [skills, setSkills] = useState<{ skills: SkillInfo[]; invalid: { name: string; reason: string }[] }>({
    skills: [],
    invalid: [],
  });
  const loadSkills = useCallback(() => {
    void api
      .skills()
      .then(setSkills)
      .catch(() => setSkills({ skills: [], invalid: [] }));
  }, []);
  useEffect(() => {
    if (active === "skills") loadSkills();
  }, [active, loadSkills]);
  const [modules, setModules] = useState<{ modules: ModuleInfo[]; invalid: { name: string; reason: string }[]; builtins?: { name: string; description: string; enabled: boolean }[] }>({
    modules: [],
    invalid: [],
  });
  const [moduleBusy, setModuleBusy] = useState<string | null>(null);
  const [newInstance, setNewInstance] = useState<Record<string, string>>({});
  const [installSource, setInstallSource] = useState("");
  const [skillBusy, setSkillBusy] = useState<string | null>(null);
  /** Which skills the list shows: all, one project's, a kind or a state. */
  const [skillView, setSkillView] = useState("all");
  /** The servers in mcp.json, with whether each is up. */
  const [mcp, setMcp] = useState<McpServerInfo[]>([]);
  const [mcpBusy, setMcpBusy] = useState<string | null>(null);
  const loadMcp = useCallback(() => {
    void api
      .mcpServers()
      .then((r) => setMcp(r.servers))
      .catch(() => setMcp([]));
  }, []);
  useEffect(() => {
    if (active === "mcp") loadMcp();
  }, [active, loadMcp]);
  /** How the browser runs, as the server has it, and the draft being edited. */
  /** How iMessage came up, for the Providers tab: a permission it lacks is news the owner can act on. */
  const [imessage, setImessage] = useState<Status["imessage"] | null>(null);
  useEffect(() => {
    if (active !== "providers") return;
    void api
      .status()
      .then((s) => setImessage(s.imessage ?? null))
      .catch(() => undefined);
  }, [active]);
  /** A restart wanted from this page, and what it is waiting on; polled while the tab is open. */
  const [restart, setRestart] = useState<RestartState | null>(null);
  useEffect(() => {
    if (active !== "workspace") return;
    const read = (): void => {
      void api
        .status()
        .then((s) => setRestart(s.restart ?? null))
        .catch(() => undefined);
    };
    read();
    const t = window.setInterval(read, 3000);
    return () => window.clearInterval(t);
  }, [active]);
  const [browser, setBrowser] = useState<BrowserSettings | null>(null);
  const [browserDraft, setBrowserDraft] = useState<{ headed: boolean; chrome: string; extensions: string[]; search: string } | null>(null);
  const openTab = useOpenTab();
  const takeBrowser = useCallback((b: BrowserSettings) => {
    setBrowser(b);
    setBrowserDraft({ headed: b.headed, chrome: b.chrome, extensions: b.extensions, search: b.search });
  }, []);
  useEffect(() => {
    if (active !== "browser") return;
    void api.browserSettings().then(takeBrowser).catch(() => setBrowser(null));
  }, [active, takeBrowser]);
  const browserDirty =
    !!browser && !!browserDraft && JSON.stringify(browserDraft) !== JSON.stringify({ headed: browser.headed, chrome: browser.chrome, extensions: browser.extensions, search: browser.search });
  /** A server from the name and the command line or URL typed for it. */
  const loadModules = useCallback(() => {
    void api
      .modules()
      .then(setModules)
      .catch(() => setModules({ modules: [], invalid: [] }));
  }, []);
  useEffect(() => {
    if (active === "modules") loadModules();
  }, [active, loadModules]);
  const [rules, setRules] = useState<PermissionRule[]>([]);
  const loadRules = useCallback(() => {
    void api.permissions().then((r) => setRules(r.rules)).catch(() => setRules([]));
  }, []);
  useEffect(() => {
    if (active === "permissions") loadRules();
  }, [active, loadRules]);
  const [saved, setSaved] = useState<Partial<Record<SectionId, string>>>({});

  const [profile, setProfile] = useState({ name: "", timezone: "" });
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [ports, setPorts] = useState<Record<string, string>>({});
  const [buildModel, setBuildModel] = useState("");
  const [retention, setRetention] = useState({
    maxChars: "",
    maxToolResultChars: "",
    maxExchanges: "",
    // A string like the rest, so one dirty check covers the whole card.
    autoTrim: "on",
  });

  const zones = useRef<string[]>(timezones());

  const load = (): void => {
    void api
      .settings()
      .then((r) => {
        setData(r);
        setProfile({ name: r.profile.name, timezone: r.profile.timezone });
        setBuildModel(r.buildModel ?? "");
        setRetention({
          maxChars: String(r.retention.maxChars),
          maxToolResultChars: String(r.retention.maxToolResultChars),
          maxExchanges: String(r.retention.maxExchanges),
          autoTrim: r.retention.autoTrim === false ? "off" : "on",
        });
        setError(null);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
  };

  useEffect(load, []);
  useEffect(() => {
    void api
      .behaviour()
      .then((r) => {
        setHow(r.behaviour);
        setSavedHow(r.behaviour);
        setDefaults(r.defaults);
        setLimits(r.limits);
      })
      // Unreadable settings stay at the conservative values rather than
      // showing numbers that are not the ones in force.
      .catch(() => undefined);
  }, []);

  const done = (section: SectionId, message: string): void => {
    setSaved((s) => ({ ...s, [section]: message }));
    window.setTimeout(
      () => setSaved((s) => ({ ...s, [section]: undefined })),
      2500,
    );
  };

  const run = (section: SectionId, work: Promise<unknown>, message: string): void => {
    setBusy(section);
    void work
      .then(() => {
        done(section, message);
        load();
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setBusy(null));
  };

  /**
   * Saved, then adopted from the reply: the server clamps every number, so
   * what comes back is what is in force. Keeping the typed value instead
   * would show 500 in a field that actually holds 100.
   */
  const saveHow = (): void => {
    setBusy("behaviour");
    void api
      .saveBehaviour(how)
      .then((r) => {
        setHow(r.behaviour);
        setSavedHow(r.behaviour);
        done("behaviour", "Saved");
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setBusy(null));
  };

  /**
   * The same Save on every tab.
   *
   * Each tab used to wire its own: some always pressable, some not; some
   * saying "Saved", some silent; Models with three of them. One helper, so a
   * tab cannot express a different idea of what saving is.
   */
  const saveBar = (
    section: SectionId,
    dirty: boolean,
    onSave: () => void,
    extra?: ReactNode,
  ): {
    saving: boolean;
    saved: string | null;
    canSave: boolean;
    onSave: () => void;
    extra?: ReactNode;
  } => ({
    saving: busy === section,
    saved: dirty ? "Not saved yet" : (saved[section] ?? null),
    canSave: dirty,
    onSave,
    ...(extra ? { extra } : {}),
  });

  const saveBrowser = (): void => {
    if (!browserDraft) return;
    setBusy("browser");
    void api
      .saveBrowserSettings(browserDraft)
      .then((b) => {
        takeBrowser(b);
        done("browser", "Saved; restart the browser to apply");
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(null));
  };
  const restartBrowser = (): void => {
    setBusy("browser");
    void api
      .browserRestart()
      .then((s) => done("browser", s.attached ? "Browser restarted" : "Browser restarting"))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(null));
  };

  const same = (a: Behaviour, b: Behaviour): boolean =>
    (Object.keys(a) as (keyof Behaviour)[]).every((k) => a[k] === b[k]);
  const changed = !same(how, savedHow);
  const atDefaults = same(how, defaults);

  const saveEnv = (
    section: SectionId,
    draft: Record<string, string>,
    clear: () => void,
  ): void => {
    const values: Record<string, string> = {};
    // Only what was actually typed. An untouched field sent as an empty string
    // would read as "clear this key".
    for (const [k, v] of Object.entries(draft)) if (v !== "") values[k] = v;
    if (Object.keys(values).length === 0) {
      done(section, "Nothing changed");
      return;
    }
    setBusy(section);
    void api
      .saveSettings(values)
      .then(() => {
        clear();
        done(section, "Saved");
        load();
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setBusy(null));
  };

  if (!data) {
    return (
      <div className="settings-page">
        {error ? (
          <p className="ops-alert ops-alert--err" role="alert">
            {error}
          </p>
        ) : (
          <p className="hint">Loading…</p>
        )}
      </div>
    );
  }

  const networkKeys = Object.entries(data.settings).filter(
    ([, m]) => m.group === "network",
  );
  const accessKeys = Object.entries(data.settings).filter(
    ([, m]) => m.group === "access",
  );
  // What the host describes (keys, ports) is found by its own words too.
  const entries: SettingEntry[] = [
    ...SETTINGS,
    ...Object.values(data.secrets).map((meta) => ({ section: "providers" as const, label: meta.label, ...(meta.hint ? { words: meta.hint } : {}) })),
    ...[...networkKeys, ...accessKeys].map(([, meta]) => ({ section: "network" as const, label: meta.label, ...(meta.hint ? { words: meta.hint } : {}) })),
  ];
  const hits = searchSettings(query, entries);

  return (
    <div className="settings-page">
      <div className="set-side" ref={sideFade}>
        <div className="set-search">
          <SearchField
            className="set-search-input"
            noun="settings"
            value={query}
            onChange={(v) => {
              setQuery(v);
              setPicked(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setPicked((p) => Math.max(0, Math.min(hits.length - 1, p + (e.key === "ArrowDown" ? 1 : -1))));
              } else if (e.key === "Enter" && hits[picked]) {
                e.preventDefault();
                jump(hits[picked]!);
              } else if (e.key === "Escape") {
                e.preventDefault();
                setQuery("");
                e.currentTarget.blur();
              }
            }}
          />
        </div>
        <nav className={`set-rail${query.trim() ? " set-rail--found" : ""}`} aria-label="Settings sections" ref={railScroll}>
        {query.trim() ? (
          <div className="set-results" role="listbox" aria-label="Settings found">
            {hits.length === 0 && <EmptyState variant="inline" className="set-results-none">Nothing called that. Try another word.</EmptyState>}
            {hits.map((hit, i) => {
              const sec = SECTIONS.find((s) => s.id === hit.section)!;
              return (
                <button
                  key={`${hit.section}:${hit.label ?? ""}`}
                  type="button"
                  role="option"
                  aria-selected={i === picked}
                  className={`set-rail-item set-result ${i === picked ? "is-on" : ""}`}
                  onMouseEnter={() => setPicked(i)}
                  onClick={() => jump(hit)}
                >
                  <span className="set-rail-label">
                    <Marked text={hit.label ?? sec.label} marks={marksOfLetters(hit.marks)} />
                  </span>
                  <span className="set-rail-blurb">{hit.label ? `${sec.group} · ${sec.label}` : sec.blurb}</span>
                </button>
              );
            })}
          </div>
        ) : GROUPS.map((group) => (
          <div key={group} className="set-rail-group">
            <h3 className="label set-rail-head">{group}</h3>
            {SECTIONS.filter((s) => s.group === group).map((s) => (
              <button
                key={s.id}
                type="button"
                className={`set-rail-item ${active === s.id ? "is-on" : ""}`}
                onClick={() => {
                  setFound(null);
                  setActive(s.id);
                }}
              >
                <span className="set-rail-label">{s.label}</span>
                <span className="set-rail-blurb">{s.blurb}</span>
              </button>
            ))}
          </div>
        ))}
        </nav>
      </div>

      {/* Keyed on the tab, so moving between them is a change you can follow
          rather than one frame replaced by another. */}
      <div className="set-pane-scroll" ref={paneScroll}>
      <m.div
        className="set-pane"
        key={active}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={ease}
      >
        {error && (
          <p className="ops-alert ops-alert--err" role="alert">
            {error}
          </p>
        )}
        {!data.envWritable && active !== "spend" && active !== "models" && (
          <p className="ops-alert ops-alert--err" role="alert">
            {data.envPath
              ? "The settings file is inside the workspace, so nothing can be saved there: KOS can read anything in the workspace. Move it out and restart."
              : "This host was started without a settings file, so nothing can be saved from here."}
          </p>
        )}

        {active === "you" && (
          <Section
            title="You"
            blurb="Used in the system prompt and to decide what today means for a schedule."
            {...saveBar(
              "you",
              profile.name !== (data.profile?.name ?? "") ||
                profile.timezone !== (data.profile?.timezone ?? ""),
              () =>
                run(
                  "you",
                  api.saveProfile(profile.name, profile.timezone),
                  "Saved",
                ),
            )}
          >
            <Field group className="set-field" label="Name" hint="What KOS calls you.">
              <input
                className="kos-input"
                value={profile.name}
                onChange={(e) => setProfile((p) => ({ ...p, name: e.target.value }))}
              />
            </Field>
            <Field group className="set-field"
              label="Timezone"
              hint="Schedules and “today” follow this. Checked against what this machine knows, so a typo cannot quietly move every schedule."
            >
              {zones.current.length > 0 ? (
                <Select
                  className="set-select"
                  label="Timezone"
                  value={profile.timezone}
                  options={zones.current.map((z) => ({ value: z, label: z }))}
                  onChange={(v) => setProfile((p) => ({ ...p, timezone: v }))}
                />
              ) : (
                <input
                  className="kos-input"
                  value={profile.timezone}
                  onChange={(e) =>
                    setProfile((p) => ({ ...p, timezone: e.target.value }))
                  }
                />
              )}
            </Field>
            <Field group className="set-field" label="Owner id" hint="Identifies you across channels. Set at first run.">
              <input className="kos-input" value={data.profile.ownerId} readOnly />
            </Field>
            {/* Not a setting: where a rule the owner states is kept, so "never message me after 10pm" has a home to find. */}
            <Field group className="set-field" label="Standing rules" hint={STANDING_RULES_HINT}>
              <a className="btn btn--sm" href={hrefFor({ name: "memory" })}>Open Memory</a>
            </Field>
          </Section>
        )}

        {active === "providers" && (
          <Section
            title="Providers"
            blurb="Stored outside the workspace, readable only by you. KOS shows the last four characters so you can tell two keys apart; it never sends the value back."
            {...saveBar("providers", Object.keys(keys).length > 0, () =>
              saveEnv("providers", keys, () => setKeys({})),
            )}
          >
            {imessage?.state === "failed" && (
              <p className="ops-alert ops-alert--err" role="alert">
                iMessage is not running. {imessage.detail}
              </p>
            )}
            {imessage?.state === "skipped" && <p className="hint">iMessage was skipped: {imessage.detail}.</p>}
            {Object.entries(data.secrets).map(([key, meta]) => (
              <Field group className="set-field"
                key={key}
                label={meta.label}
                // A sample of the key's shape ("sk-...") is the box's placeholder; words about it are its hint.
                {...(meta.hint && /\s/.test(meta.hint) ? { hint: meta.hint } : {})}
                badge={
                  meta.masked ? (
                    <>
                      <Pill tone="ok">{meta.masked}</Pill>
                      {meta.storedAs && (
                        <Tag mono title="An older name this host still accepts">
                          as {meta.storedAs}
                        </Tag>
                      )}
                    </>
                  ) : (
                    <Pill>Not set</Pill>
                  )
                }
              >
                <div className="set-inline">
                  <input
                    className="kos-input"
                    type="password"
                    autoComplete="new-password"
                    value={keys[key] ?? ""}
                    placeholder={meta.masked ? "Unchanged" : meta.hint && !/\s/.test(meta.hint) ? meta.hint : "Paste it here"}
                    onChange={(e) =>
                      setKeys((k) => ({ ...k, [key]: e.target.value }))
                    }
                  />
                  {meta.masked && (
                    <button
                      type="button"
                      className="btn btn--ghost"
                      disabled={busy === "providers"}
                      onClick={() =>
                        run("providers", api.saveSettings({ [key]: "" }), "Cleared")
                      }
                    >
                      Clear
                    </button>
                  )}
                </div>
              </Field>
            ))}
          </Section>
        )}

        {active === "models" && (
          /* One card, one Save, like every other tab. This was three cards
             with three Saves, which is the shape the rest of Settings was
             changed away from. */
          <Section
            title="Models"
            blurb="Which model KOS thinks with. The model chip under a chat's box opens this page."
            {...saveBar(
              "models",
              how.engine !== savedHow.engine ||
                modelsDirty ||
                buildModel !== (data.buildModel ?? ""),
              () => {
                // One press writes all three, in the order that matters: the
                // engine decides whether the model choices below apply.
                void run(
                  "models",
                  api
                    .saveBehaviour(how)
                    .then(() => api.saveBuildModel(buildModel)),
                  "Saved",
                );
                saveModels.current?.();
                setSavedHow(how);
              },
            )}
          >
            <div className="set-group">
              <h2>Who does the thinking</h2>
              <p className="hint">
                A chat can go to a model provider with your API key, billed by
                use, or through Claude Code signed in on this computer, which
                uses that subscription instead.
              </p>
              <Field group className="set-field"
                label="Chat engine"
                hint="Either way KOS works only inside its own folder, and anything risky still asks you first. Claude Code needs to be signed in on this computer, or an Anthropic key under Providers."
              >
                <Select
                  className="set-select"
                  label="Chat engine"
                  value={how.engine}
                  options={[
                    { value: "api", label: "Model provider", hint: "your API key, billed by use" },
                    {
                      value: "sdk",
                      label: "Claude Code",
                      hint: "your Claude subscription",
                    },
                  ]}
                  onChange={(v) =>
                    setHow({ ...how, engine: v === "sdk" ? "sdk" : "api" })
                  }
                />
              </Field>
            </div>

            <div className="set-group">
              <h2>Which model answers</h2>
              <p className="hint">
                Three models, each for its own work. A change applies from the
                next message, no restart. Left blank, each uses its
                provider's usual model. While Claude Code answers, it picks
                its own.
              </p>
              <ModelSettings
                onReady={(fn, dirty) => {
                  saveModels.current = fn;
                  // Only on a change. This is called after every render of
                  // the child, so setting state unconditionally re-rendered
                  // it, which called this again: the page locked solid.
                  setModelsDirty((was) => (was === dirty ? was : dirty));
                }}
              />
            </div>

            <div className="set-group">
              <h2>Builds</h2>
              <p className="hint">
                The model that writes code when KOS starts a build.
              </p>
              <Field group className="set-field"
                label="Build model"
                hint="A build talks to its model many times, so this decides most of how long one takes. Sonnet is much faster than Opus for setting a project up."
              >
                <Select
                  className="set-select"
                  label="Build model"
                  value={buildModel}
                  options={[
                    { value: "", label: "Claude Code default" },
                    { value: "sonnet", label: "Sonnet", hint: "faster" },
                    { value: "opus", label: "Opus", hint: "more capable" },
                    { value: "fable", label: "Fable" },
                  ]}
                  onChange={setBuildModel}
                />
              </Field>
            </div>
          </Section>
        )}

        {active === "behaviour" && (
          /* One card, like every other tab. It was three chained cards and a
             footer of its own, which is why this tab read as a different
             application from the rest of Settings. */
          <Section
            title="Behaviour"
            blurb="How KOS acts when you are not watching."
            {...saveBar(
              "behaviour",
              changed,
              saveHow,
              <button
                type="button"
                className="btn"
                disabled={busy === "behaviour" || atDefaults}
                onClick={() => setHow(defaults)}
              >
                Reset to defaults
              </button>,
            )}
          >
            <div className="set-group">
              <h2>When something fails</h2>
              <p className="hint">
                A schedule that fails at 3am tells you either way. This decides
                whether KOS also tries to do something about it before you wake
                up.
              </p>
              <FieldRow
                label="Extract memory in the background"
                hint="When on, the cheap model reads new messages once enough have built up, and notes what seems worth remembering and where it heard it. Its notes show in Memory, marked as its own. New workspaces start with it off."
              >
                <Switch label="Extract memory in the background" on={how.memoryExtraction} onChange={(on) => setHow({ ...how, memoryExtraction: on })} />
              </FieldRow>
              <FieldRow
                label="Try to fix failures on its own"
                hint="The first time a schedule fails, KOS opens a chat, works out why, and fixes it if it safely can. It tries once per schedule, and still asks you before anything risky."
              >
                <Switch label="Try to fix failures on its own" on={how.autoFix} onChange={(on) => setHow({ ...how, autoFix: on })} />
              </FieldRow>
              <FieldRow
                label="Set big results aside once read"
                hint="A web page, a PDF or a long list stays whole for two messages. After that the chat keeps a short outline and KOS looks the rest up again when it needs it, so later messages stay quick and cheap. Off, all of it is sent with every message."
              >
                <Switch label="Set big results aside once read" on={how.smartContext} onChange={(on) => setHow({ ...how, smartContext: on })} />
              </FieldRow>
            </div>

            <div className="set-group">
              <h2>How hard it tries</h2>
              <p className="hint">
                A step is one thought and one action, such as reading a file.
                At the limit KOS stops and tells you it got stuck, rather than
                going on.
              </p>
              <div className="set-grid">
                <Limit
                  label="Steps in a turn"
                  hint={`How many steps KOS may take to answer one message. Usually ${defaults.maxSteps}.`}
                  value={how.maxSteps}
                  range={limits.maxSteps}
                  // Screen steps left at four times these follow them; set to anything else, the owner's number is
                  // kept as it is, so lowering these again gives it back.
                  onChange={(maxSteps) => setHow({ ...how, maxSteps, screenSteps: how.screenSteps === 4 * how.maxSteps ? 4 * maxSteps : how.screenSteps })}
                />
                <Limit
                  label="Steps on a screen, for one message"
                  hint={`Clicking through a website or an app takes many steps, so a message of yours that works a screen may take this many in all. Usually four times the steps above.`}
                  // Never shown under the steps above, which the host holds it to; typed, any number in range is taken.
                  value={Math.max(how.screenSteps, how.maxSteps)}
                  range={limits.screenSteps}
                  onChange={(screenSteps) => setHow({ ...how, screenSteps })}
                />
                <Limit
                  label="Steps in a fix attempt"
                  hint={`Working out why something failed is mostly reading, so it gets more steps than a message. Usually ${defaults.fixSteps}.`}
                  value={how.fixSteps}
                  range={limits.fixSteps}
                  onChange={(fixSteps) => setHow({ ...how, fixSteps })}
                />
              </div>
            </div>

            <div className="set-group">
              <h2>Unattended work</h2>
              <p className="hint">
                Limits on what KOS may do while nobody is watching: the guards
                against a loop that runs all night.
              </p>
              <div className="set-grid">
                <Limit
                  label="Check in on its own, every N minutes"
                  hint={`KOS looks at what has changed every so often, and messages you only if something needs you. 0 is off, the usual: this is the one setting that spends money on a timer rather than because you asked.`}
                  value={how.heartbeatMinutes}
                  range={limits.heartbeatMinutes}
                  onChange={(heartbeatMinutes) =>
                    setHow({ ...how, heartbeatMinutes })
                  }
                />
                <Limit
                  label="Read new chat for memory after this many characters"
                  hint="With memory in the background on, the cheap model reads once this much new chat has piled up. Usually 6000, about a page and a half."
                  value={how.extractEveryChars}
                  range={limits.extractEveryChars}
                  onChange={(extractEveryChars) =>
                    setHow({ ...how, extractEveryChars })
                  }
                />
                <Limit
                  label="Settle a memory question alone when at least N% sure"
                  hint={`When two things KOS remembers disagree, it says what it would do and how sure it is. At least this sure, it does it and Memory says so; less sure, it asks you in the Inbox. 100 means only when certain. Usually ${defaults.memoryDecideAbove}.`}
                  value={how.memoryDecideAbove}
                  range={limits.memoryDecideAbove}
                  onChange={(memoryDecideAbove) =>
                    setHow({ ...how, memoryDecideAbove })
                  }
                />
                <Limit
                  label="Schedules that ask KOS, per hour"
                  hint={`Schedules that ask KOS to think, not ones that run fixed steps. 0 stops them all. Usually ${defaults.selfPromptsPerHour}.`}
                  value={how.selfPromptsPerHour}
                  range={limits.selfPromptsPerHour}
                  onChange={(selfPromptsPerHour) =>
                    setHow({ ...how, selfPromptsPerHour })
                  }
                />
                <Limit
                  label="Minutes to wait for your approval"
                  hint={`A chat waiting on your yes holds still until you answer. After this long, no answer counts as no. Usually ${defaults.approvalMinutes}.`}
                  value={how.approvalMinutes}
                  range={limits.approvalMinutes}
                  onChange={(approvalMinutes) =>
                    setHow({ ...how, approvalMinutes })
                  }
                />
                <Limit
                  label="Hours an unanswered ask keeps"
                  hint={`An ask nobody is waiting on, such as one from a schedule, expires after this: it leaves the Inbox and the chat is told nothing was done. Usually ${defaults.approvalExpiryHours}.`}
                  value={how.approvalExpiryHours}
                  range={limits.approvalExpiryHours}
                  onChange={(approvalExpiryHours) =>
                    setHow({ ...how, approvalExpiryHours })
                  }
                />
                <Limit
                  label="Minutes a build may run"
                  hint={`A build is stopped at this, whatever it is doing. Usually ${defaults.agentMinutes}.`}
                  value={how.agentMinutes}
                  range={limits.agentMinutes}
                  onChange={(agentMinutes) => setHow({ ...how, agentMinutes })}
                />
                <Limit
                  label="Steps a build may take"
                  hint={`The same limit, counted in steps rather than time. Usually ${defaults.agentTurns}.`}
                  value={how.agentTurns}
                  range={limits.agentTurns}
                  onChange={(agentTurns) => setHow({ ...how, agentTurns })}
                />
                <Limit
                  label="Minutes of quiet before a build looks stuck"
                  hint={`Only what the Builds page says about it; nothing is stopped. Usually ${defaults.stallMinutes}.`}
                  value={how.stallMinutes}
                  range={limits.stallMinutes}
                  onChange={(stallMinutes) => setHow({ ...how, stallMinutes })}
                />
              </div>
            </div>
          </Section>
        )}

        {active === "appearance" && (
          <Section
            title="Appearance"
            blurb="How KOS looks. The theme is KOS's own: every tab of the dashboard, and every device set to follow it, draws it. Density is this browser's."
          >
            <Field group className="set-field" label="Theme" hint="System is the default, and follows each device's own appearance. KOS for Chrome and KOS for Mac follow this unless set otherwise there." {...(themeNote ? { error: themeNote } : {})}>
              <Select
                className="set-select"
                label="Theme"
                value={theme}
                options={[
                  { value: "dark", label: "Dark" },
                  { value: "light", label: "Light" },
                  { value: "system", label: "System" },
                ]}
                onChange={(v) => {
                  if (!isTheme(v)) return;
                  setThemeNote(null);
                  chooseTheme(v, api.saveTheme).catch((e: unknown) => setThemeNote(`Not saved to KOS: ${e instanceof Error ? e.message : String(e)}`));
                }}
              />
            </Field>
            <Field group className="set-field"
              label="Density"
              hint="Compact fits more rows on a laptop. Comfortable makes type and spacing a little larger everywhere, for a phone or a long read."
            >
              <Select
                className="set-select"
                label="Density"
                value={density}
                options={[
                  { value: "compact", label: "Compact" },
                  { value: "standard", label: "Standard" },
                  { value: "comfortable", label: "Comfortable" },
                ]}
                onChange={(v) => {
                  if (isDensity(v)) {
                    setDensity(v);
                    setDensityState(v);
                  }
                }}
              />
            </Field>
            <Field group className="set-field"
              label="KOS's face"
              hint="The blob in the sidebar, the chat rail and the tab icon. Kept in the workspace, not this browser, so every screen and the tab agree. Left alone, it comes from the name."
            >
              <FaceEditor seed={KOS_SEED} value={kosFace} onChange={(face) => void saveKosFace(face)} label="KOS's face" />
              {kosFaceNote && <span className="hint">{kosFaceNote}</span>}
            </Field>
          </Section>
        )}

        {active === "conversation" && (
          <Section
            title="Conversation"
            blurb="How much of a chat KOS rereads with each new message. Past these limits the oldest messages drop off; type /compact in a chat to fold them into a short summary instead. 0 means no limit, but then a long chat gets slower and costs more with every message."
            {...saveBar(
              "conversation",
              retention.maxChars !== String(data.retention.maxChars) ||
                retention.maxToolResultChars !==
                  String(data.retention.maxToolResultChars) ||
                retention.maxExchanges !== String(data.retention.maxExchanges) ||
                retention.autoTrim !==
                  (data.retention.autoTrim === false ? "off" : "on"),
              () =>
                run(
                  "conversation",
                  api.saveRetention({
                    maxChars: Number(retention.maxChars),
                    maxToolResultChars: Number(retention.maxToolResultChars),
                    maxExchanges: Number(retention.maxExchanges),
                    autoTrim: retention.autoTrim !== "off",
                  }),
                  "Saved",
                ),
            )}
          >
            <FieldRow
              label="Drop old messages"
              hint="On, the oldest messages drop off once a chat passes the limits below, and the chat says so. Off keeps everything, so a long chat gets slower and costs more as it grows."
            >
              <Switch label="Drop old messages" on={retention.autoTrim !== "off"} onChange={(on) => setRetention((r) => ({
                      ...r,
                      autoTrim: on ? "on" : "off",
                    }))
                  } />
            </FieldRow>
            <Field group className="set-field"
              label="Chat length KOS rereads, in characters"
              hint={`About 3,000 characters is a page. 0 for no limit. Usually ${data.retentionDefaults.maxChars.toLocaleString()}.`}
            >
              <input
                className="kos-input"
                inputMode="numeric"
                value={retention.maxChars}
                onChange={(e) =>
                  setRetention((r) => ({ ...r, maxChars: e.target.value }))
                }
              />
            </Field>
            <Field group className="set-field"
              label="Messages KOS rereads"
              hint={`Each message and its answer count as one, however short. 0 for no limit. Usually ${data.retentionDefaults.maxExchanges}.`}
            >
              <input
                className="kos-input"
                inputMode="numeric"
                value={retention.maxExchanges}
                onChange={(e) =>
                  setRetention((r) => ({ ...r, maxExchanges: e.target.value }))
                }
              />
            </Field>
            <Field group className="set-field"
              label="Longest single result, in characters"
              hint={`A file, a page or a list KOS read that is longer than this is cut short to fit, not dropped. 0 for no limit. Usually ${data.retentionDefaults.maxToolResultChars.toLocaleString()}.`}
            >
              <input
                className="kos-input"
                inputMode="numeric"
                value={retention.maxToolResultChars}
                onChange={(e) =>
                  setRetention((r) => ({
                    ...r,
                    maxToolResultChars: e.target.value,
                  }))
                }
              />
            </Field>
            <p className="set-note">
              A change applies from the next message. Lowering a limit does not
              delete anything a chat already has.
            </p>
          </Section>
        )}

        {active === "network" && (
          <Section
            title="Network"
            blurb="Where KOS listens and what it may reach. Applied the next time the host starts."
            {...saveBar("network", Object.keys(ports).length > 0, () =>
              saveEnv("network", ports, () => setPorts({})),
            )}
          >
            {networkKeys.map(([key, meta]) => (
              <Field group className="set-field"
                key={key}
                label={meta.label}
                hint={meta.hint}
                badge={
                  meta.value ? <Pill tone="ok">{meta.value}</Pill> : null
                }
              >
                <input
                  className="kos-input"
                  value={ports[key] ?? ""}
                  placeholder={meta.value || "default"}
                  onChange={(e) => setPorts((p) => ({ ...p, [key]: e.target.value }))}
                />
              </Field>
            ))}
            {accessKeys.map(([key, meta]) => (
              <Field group className="set-field" key={key} label={meta.label} hint={meta.hint}>
                {/* A list, edited as a list. It was one text box holding
                    comma-separated hosts, which reads as a sentence and
                    edits like one: no way to see what is on it at a glance,
                    and removing the middle entry meant surgery on a string. */}
                <HostList
                  value={ports[key] ?? meta.value ?? ""}
                  onChange={(next) => setPorts((p) => ({ ...p, [key]: next }))}
                />
              </Field>
            ))}
            <DashboardTokenField />
          </Section>
        )}

        {active === "skills" && (
          <Section title="Skills" blurb="What KOS knows how to do. One it wrote is on; one you install is off until you switch it on.">
            {skills.skills.length === 0 && skills.invalid.length === 0 && (
              <EmptyState variant="inline">Nothing installed yet. Add one below, or ask KOS to make one.</EmptyState>
            )}
            {skills.skills.length > 0 && (
              <FieldRow label="Show" hint="All of them, one project's own, a kind, or a state.">
                <Select className="settings-select" label="Which skills" value={skillView} options={skillViews(skills.skills)} onChange={setSkillView} />
              </FieldRow>
            )}
            <div className="set-rows">
            {skills.skills.filter((sk) => matchesSkillView(sk, skillView)).map((sk) => (
              <FieldRow
                key={sk.name}
                label={`${sk.name} (${sk.kind}${sk.kind === "script" ? (sk.promoted ? ", promoted" : ", not promoted") : ""})${sk.projects ? ` · ${sk.projects.join(", ")}` : ""}`}
                hint={sk.description}
                {...(sk.origin ? { meta: <span className="set-origin ops-mono">{sk.origin}</span> } : {})}
              >
                <Switch label={sk.name} on={sk.enabled} disabled={skillBusy === sk.name} onChange={(on) => {
                      const enabled = on;
                      // Shown at once; the list is re-read after the save so
                      // what is on screen is what the server has.
                      setSkills((cur) => ({ ...cur, skills: cur.skills.map((x) => (x.name === sk.name ? { ...x, enabled } : x)) }));
                      void api.setSkillEnabled(sk.name, enabled).then(loadSkills, loadSkills);
                    }} />
                <span className="set-module-actions">
                  {/* The file itself, in Files: what a script does is in its code, what a prompt skill says is in its text. */}
                  <a className="link" href={hrefFor({ name: "files", path: sk.file })}>
                    Open
                  </a>
                  {sk.origin && (
                    <button
                      type="button"
                      className="link"
                      disabled={skillBusy === sk.name}
                      onClick={() => {
                        setSkillBusy(sk.name);
                        void api.updateSkill(sk.name).then(loadSkills).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err))).finally(() => setSkillBusy(null));
                      }}
                    >
                      Update
                    </button>
                  )}
                  <button
                    type="button"
                    className="link is-danger"
                    disabled={skillBusy === sk.name}
                    onClick={() => {
                      setSkillBusy(sk.name);
                      void api.removeSkill(sk.name).then(loadSkills).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err))).finally(() => setSkillBusy(null));
                    }}
                  >
                    Remove
                  </button>
                </span>
              </FieldRow>
            ))}
            </div>
            {skills.invalid.length > 0 && (
              <div className="set-group">
                <h2>Could not be read</h2>
                {skills.invalid.map((bad) => (
                  <p key={bad.name} className="hint">
                    <span className="ops-mono">{bad.name}</span>: {bad.reason}
                  </p>
                ))}
              </div>
            )}
            <SkillsAdd onInstalled={loadSkills} />
          </Section>
        )}
        {active === "mcp" && (
          <Section title="MCP servers" blurb="Outside tools, declared in mcp.json the way Claude Code does. A server's tools are risky until you floor them safe.">
            {mcp.length === 0 && <EmptyState variant="inline">Nothing connected yet. Add one below.</EmptyState>}
            <div className="set-rows">
            {mcp.map((s) => (
              <FieldRow
                key={s.name}
                label={`${s.name} (${s.transport})${s.projects.length ? ` · ${s.projects.join(", ")}` : ""}`}
                meta={
                  <span className="set-origin">
                    {s.risk === "safe" ? "all tools safe" : "risky: each call asks"}
                    {Object.keys(s.floors).length > 0 && ` · floors: ${Object.entries(s.floors).map(([t, f]) => `${t} ${f}`).join(", ")}`}
                  </span>
                }
                hint={
                  !s.enabled
                    ? `${s.command} · off`
                    : s.error
                      ? `${s.command} · not connected: ${s.error}`
                      : s.connected
                        ? `${s.command} · serving ${s.tools?.length ?? 0} tool${s.tools?.length === 1 ? "" : "s"}`
                        : `${s.command} · starting`
                }
              >
                <Switch label={s.name} on={s.enabled} disabled={mcpBusy === s.name} onChange={(on) => {
                      const enabled = on;
                      setMcpBusy(s.name);
                      void api.setMcpServerEnabled(s.name, enabled).then(loadMcp, loadMcp).finally(() => setMcpBusy(null));
                    }} />
                <span className="set-module-actions">
                  <button
                    type="button"
                    className="link is-danger"
                    disabled={mcpBusy === s.name}
                    onClick={() => {
                      setMcpBusy(s.name);
                      void api.removeMcpServer(s.name).then(loadMcp).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err))).finally(() => setMcpBusy(null));
                    }}
                  >
                    Remove
                  </button>
                </span>
              </FieldRow>
            ))}
            </div>
            <McpAdd onAdded={loadMcp} />
          </Section>
        )}
        {active === "modules" && (
          <Section title="Modules" blurb="Each one is a folder under modules/ with a module.json. A server module runs tools, and off is the default: nothing runs until you switch it on here. A blueprint is a project template; each instance is a project of its own.">
            {(modules.builtins ?? []).length > 0 && (
              <div className="set-group">
                <h2>Built in</h2>
                <p className="hint">Features the kernel ships but does not insist on. Off takes their tools away at once; on brings them back.</p>
                <div className="set-rows">
                {(modules.builtins ?? []).map((b) => (
                  <FieldRow key={b.name} label={b.name} hint={b.description}>
                    <Switch label={b.name} on={b.enabled} onChange={(on) => {
                          const enabled = on;
                          void api.setModuleEnabled(b.name, enabled).then(loadModules, loadModules);
                        }} />
                  </FieldRow>
                ))}
                </div>
              </div>
            )}
            {modules.modules.length === 0 && modules.invalid.length === 0 && (
              <EmptyState variant="inline">No workspace modules yet. Ask KOS to make one with modules.create, install one below, or add a folder under modules/.</EmptyState>
            )}
            {/* The second rung of the spec's distribution path: a repository
                per module. Installed is off; nothing runs until switched on. */}
            <form
              className="set-instance-new set-install"
              onSubmit={(e) => {
                e.preventDefault();
                const source = installSource.trim();
                if (!source) return;
                setModuleBusy("install");
                void api
                  .installModule(source)
                  .then(() => {
                    setInstallSource("");
                    loadModules();
                  })
                  .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
                  .finally(() => setModuleBusy(null));
              }}
            >
              <input
                className="kos-input"
                placeholder="Install from a git URL or a folder path"
                value={installSource}
                onChange={(e) => setInstallSource(e.target.value)}
              />
              <button type="submit" className="btn btn--sm" disabled={moduleBusy === "install" || !installSource.trim()}>
                {moduleBusy === "install" ? "…" : "Install"}
              </button>
            </form>
            {modules.modules.map((m) => (
              <Field group className="set-field"
                key={m.name}
                label={m.name}
                hint={
                  m.blueprint
                    ? `${m.description} · blueprint: ${m.blueprint.schema} schema change${m.blueprint.schema === 1 ? "" : "s"}, ${m.blueprint.pages} page${m.blueprint.pages === 1 ? "" : "s"}, ${m.blueprint.jobs} job${m.blueprint.jobs === 1 ? "" : "s"}`
                    : m.error
                      ? `${m.description} · not connected: ${m.error}`
                      : m.connected && m.tools
                        ? `${m.description} · serving ${m.tools.length} tool${m.tools.length === 1 ? "" : "s"}`
                        : m.description
                }
              >
                {m.blueprint ? (
                  /* A template has nothing to switch on. What it has is
                     instances, and room for one more. */
                  <div className="set-instances">
                    {m.blueprint.instances.length === 0 ? (
                      <span className="hint">No instances yet.</span>
                    ) : (
                      <span className="set-instance-list">
                        {m.blueprint.instances.map((p) => (
                          <RefChip key={p.slug} kind="chat" href={`#/chats/project%3A${encodeURIComponent(p.slug)}`} title={`Open ${p.name}'s chat`}>
                            {p.name}
                          </RefChip>
                        ))}
                      </span>
                    )}
                    {(m.blueprint.instancing === "multi" || m.blueprint.instances.length === 0) && (
                      <form
                        className="set-instance-new"
                        onSubmit={(e) => {
                          e.preventDefault();
                          const name = (newInstance[m.name] ?? "").trim();
                          if (!name) return;
                          setModuleBusy(m.name);
                          void api
                            .instantiateModule(m.name, name)
                            .then(() => {
                              setNewInstance((cur) => ({ ...cur, [m.name]: "" }));
                              loadModules();
                            })
                            .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
                            .finally(() => setModuleBusy(null));
                        }}
                      >
                        <input
                          className="kos-input"
                          placeholder="New instance, e.g. Household 2026"
                          value={newInstance[m.name] ?? ""}
                          onChange={(e) => setNewInstance((cur) => ({ ...cur, [m.name]: e.target.value }))}
                        />
                        <button type="submit" className="btn btn--sm" disabled={moduleBusy === m.name || !(newInstance[m.name] ?? "").trim()}>
                          {moduleBusy === m.name ? "…" : "Create"}
                        </button>
                      </form>
                    )}
                  </div>
                ) : (
                <Switch label={m.name} on={m.enabled} disabled={moduleBusy === m.name} onChange={(on) => {
                      const enabled = on;
                      // The server comes up or goes down on the save, so the
                      // list is re-read afterwards to show what happened.
                      setModuleBusy(m.name);
                      void api.setModuleEnabled(m.name, enabled).then(loadModules, loadModules).finally(() => setModuleBusy(null));
                    }} />
                )}
                <span className="set-module-actions">
                  {m.origin && (
                    <button
                      type="button"
                      className="link"
                      disabled={moduleBusy === m.name}
                      onClick={() => {
                        setModuleBusy(m.name);
                        void api.updateModule(m.name).then(loadModules).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err))).finally(() => setModuleBusy(null));
                      }}
                    >
                      Update
                    </button>
                  )}
                  <button
                    type="button"
                    className="link is-danger"
                    disabled={moduleBusy === m.name}
                    onClick={() => {
                      setModuleBusy(m.name);
                      void api.removeModule(m.name).then(loadModules).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err))).finally(() => setModuleBusy(null));
                    }}
                  >
                    Remove
                  </button>
                  {m.origin && <span className="hint ops-mono">{m.origin}</span>}
                </span>
              </Field>
            ))}
            {modules.invalid.length > 0 && (
              <div className="set-group">
                <h2>Could not be read</h2>
                {modules.invalid.map((bad) => (
                  <p key={bad.name} className="hint">
                    <span className="ops-mono">{bad.name}</span>: {bad.reason}
                  </p>
                ))}
              </div>
            )}
          </Section>
        )}
        {active === "permissions" && (
          <Section title="Permissions" blurb="Each rule is an Always you pressed on an ask. KOS does that same thing again without asking, such as reading from one of the sites KOS may reach; anything different still asks. Revoke one and it asks again.">
            <Field group className="set-field" label="Secrets" hint="Logins, cards and keys KOS may fill in without seeing them, where each may be used, and when it asks.">
              <a className="btn btn--sm" href={hrefFor({ name: "secrets" })}>
                Open Secrets
              </a>
            </Field>
            {rules.length === 0 && (
              <EmptyState variant="inline">Nothing kept yet. When KOS asks before a risky action, Always approves it and keeps the decision for that shape.</EmptyState>
            )}
            {rules.map((r) => (
              <Field group className="set-field"
                key={r.id}
                label={`${r.tool}${r.scope ? ` · ${r.scope}` : ""}`}
                hint={`${r.project ? `In project ${r.project}` : "Everywhere"}${r.matches ? "" : ". Matches nothing now, so it never stops an ask; revoke it"}`}
              >
                <button
                  type="button"
                  className="btn btn--sm btn--danger"
                  onClick={() => {
                    void api.revokePermission(r.id).then(loadRules, loadRules);
                  }}
                >
                  Revoke
                </button>
              </Field>
            ))}
          </Section>
        )}
        {active === "devices" && (
          <Section title="Devices" blurb="Your Macs and your own Chrome, for KOS to see and work: a Mac through KOS for Mac, Chrome through KOS for Chrome. Each asks you before every session, shows you whenever KOS is in control, and pauses the moment you touch the mouse or keyboard.">
            <DevicesPanel />
          </Section>
        )}
        {active === "spend" && (
          <Section title="Spend" blurb="Tokens as the provider counted them.">
            <SpendPanel />
          </Section>
        )}

        {active === "browser" && (
          <Section
            title="KOS's browser"
            blurb="KOS keeps a Chrome of its own on this computer, apart from yours. Each chat that browses gets a tab there, shown as for that chat; a tab you open there is shown as opened by you. You watch it in the Browser window from the sidebar, where Take over lets you click and type in a tab. A change here applies when it next starts."
            saving={busy === "browser"}
            saved={browserDirty ? "Not saved yet" : (saved["browser"] ?? null)}
            canSave={browserDirty}
            onSave={saveBrowser}
            extra={
              <button type="button" className="btn" disabled={busy === "browser" || !browser} onClick={restartBrowser} title="Close Chrome and start it again with these settings; sign-ins stay">
                Restart the browser
              </button>
            }
          >
            {browserDraft && (
              <>
                <div className="set-group">
                  <h2>The window</h2>
                  <FieldRow
                    label="Show the window on this machine"
                    hint="Off, Chrome runs unseen and the dashboard's Browser window is the only view. On, Chrome's own windows open here too: that is how you install extensions from the Web Store, and it is where Chrome's own dialogs appear."
                  >
                    <Switch label="Show the window on this machine" on={browserDraft.headed} onChange={(on) => setBrowserDraft({ ...browserDraft, headed: on })} />
                  </FieldRow>
                  <Field group className="set-field"
                    label="Chrome to run"
                    hint="Blank runs the first Chrome found. Name a binary to run Chromium or Chrome for Testing instead."
                    meta={browser?.found ? <span className="set-browser-found">Would run: {browser.found}</span> : <span className="set-browser-found">No Chrome found on this machine.</span>}
                  >
                    <input
                      className="kos-input"
                      value={browserDraft.chrome}
                      placeholder="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
                      spellCheck={false}
                      onChange={(e) => setBrowserDraft({ ...browserDraft, chrome: e.target.value })}
                    />
                  </Field>
                </div>
                <div className="set-group">
                  <h2>Extensions</h2>
                  <p className="hint">
                    Extensions live in KOS's own Chrome profile and stay there. The sure way in is to show the window, open chrome://extensions in a tab of your own, and install from the Web Store or Load unpacked there.
                    The folders below are loaded each time Chrome starts.
                  </p>
                  <Field group className="set-field" label="Unpacked extension folders">
                    <TokenList
                      items={browserDraft.extensions}
                      onChange={(extensions) => setBrowserDraft({ ...browserDraft, extensions })}
                      placeholder="/Users/you/extensions/ublock"
                      action="Add"
                      empty="No folders. Extensions installed through the window still load."
                    />
                  </Field>
                  {openTab && (
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => void api.browserNewTab("chrome://extensions").then((r) => openTab(r.tab)).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))}
                    >
                      Open chrome://extensions in a tab
                    </button>
                  )}
                </div>
                <div className="set-group">
                  <h2>Search</h2>
                  <Field group className="set-field" label="Where the address bar searches" hint="Words that are not an address go here, with %s standing for them.">
                    <input
                      className="kos-input"
                      value={browserDraft.search}
                      placeholder="https://duckduckgo.com/?q=%s"
                      spellCheck={false}
                      onChange={(e) => setBrowserDraft({ ...browserDraft, search: e.target.value })}
                    />
                  </Field>
                </div>
              </>
            )}
          </Section>
        )}
        {active === "workspace" && (
          <Section
            title="Workspace"
            blurb="One folder holds everything KOS owns. KOS cannot see outside it."
          >
            <dl className="set-facts">
              <dt>Workspace</dt>
              <dd>
                <code>{data.workspace}</code>
              </dd>
              <dt>Settings file</dt>
              <dd>
                <code>{data.envPath ?? "none"}</code>
                <span className="set-hint">
                  Deliberately outside the workspace: that is what stops the
                  agent reading your keys.
                </span>
              </dd>
              {data.sitesUrl && (
                <>
                  <dt>Sites served at</dt>
                  <dd>
                    <code>{data.sitesUrl}</code>
                  </dd>
                </>
              )}
              <dt>KOS</dt>
              <dd>
                {data.halted ? <Pill tone="danger">halted</Pill> : <Pill tone="ok">running</Pill>}
              </dd>
            </dl>
            <div className="set-inline">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void api
                    .openWorkspace()
                    .then(() => done("workspace", "Opened"))
                    .catch((err: unknown) =>
                      setError(err instanceof Error ? err.message : String(err)),
                    );
                }}
              >
                Open folder
              </button>
              <button
                type="button"
                className={data.halted ? "btn btn--primary" : "btn btn--danger"}
                onClick={() =>
                  run("workspace", api.setKill(!data.halted), data.halted ? "Resumed" : "Halted")
                }
              >
                {data.halted ? "Resume KOS" : "Halt KOS"}
              </button>
              {restart?.pending ? (
                <button type="button" className="btn" onClick={() => void api.cancelRestart().then(setRestart).catch(() => undefined)}>
                  Cancel restart
                </button>
              ) : (
                <button
                  type="button"
                  className="btn"
                  disabled={restart !== null && !restart.supported}
                  title={restart !== null && !restart.supported ? "Nothing would start KOS again: it is not running under launchd or kos start" : "Restart the host once nothing is mid-turn"}
                  onClick={() => void api.requestRestart().then(setRestart).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))}
                >
                  Restart KOS
                </button>
              )}
              {saved.workspace && <span className="set-saved">{saved.workspace}</span>}
            </div>
            {restart?.pending && (
              <p className="set-note" role="status">
                {restart.busy.length === 0
                  ? "Restarting now. The page reconnects on its own."
                  : `Restarting when idle. Waiting on: ${restart.busy.join(", ")}.`}
              </p>
            )}
            <p className="set-note">
              Halting stops every turn and scheduled job until you resume.
              Restarting waits until no chat is mid-turn and no coding agent
              is running, so nothing is cut. The workspace is chosen when the
              host starts, with <code>--workspace</code>, so pointing KOS at a
              different folder is a restart rather than a setting.
            </p>
          </Section>
        )}
      </m.div>
      </div>
    </div>
  );
}

export type { ModelRate };
