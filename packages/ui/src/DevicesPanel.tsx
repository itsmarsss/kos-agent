import { timeWords } from "@kos/shared";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { EmptyState, Field, Pill, Switch, type Tone } from "@kos/kit";

import type { SecretSummary } from "@kos/shared";

import { api, type ComputerSettings, type DeviceBuild, type DeviceCode, type LanStatus, type PairedDevice, type PushSettings, type PushStatus } from "./api.js";
import { CommandLine, ConfirmButton, FieldRow } from "./kit.js";

import { secretsApi } from "./secrets.js";
import { Select } from "./Select.js";

/**
 * The computers KOS may use, and pairing one.
 *
 * A computer is paired by a code made here and typed (or a link opened) in
 * KOS for Mac on it. The list is polled while it is open, so a device coming
 * online, a session starting or the owner pausing it on the computer shows
 * without a reload.
 */

const POLL_MS = 3000;

const ASK_MINUTES = [5, 15, 30, 60, 120, 240, 480];

function minutesLabel(m: number): string {
  return m < 60 ? `${m} minutes` : m === 60 ? "1 hour" : `${m / 60} hours`;
}

/** What KOS asks for, and whether work the owner did not start may ask at all. */
function SessionRules({ settings, onChange }: { settings: ComputerSettings; onChange: (patch: Partial<ComputerSettings>) => void }): ReactElement {
  const options = [...new Set([...ASK_MINUTES, settings.askMinutes])].sort((a, b) => a - b);
  return (
    <div className="set-group device-rules">
      <h2>Sessions</h2>
      <Field group className="set-field" label="KOS asks for" hint="How long a session KOS asks for when the chat does not say. Each computer can allow less: its own longest session wins.">
        <Select
          label="KOS asks for"
          value={String(settings.askMinutes)}
          options={options.map((m) => ({ value: String(m), label: minutesLabel(m) }))}
          onChange={(v) => onChange({ askMinutes: Number(v) })}
        />
      </Field>
      <FieldRow
        label="Work you did not start may use a computer"
        hint="Off by default: a schedule, a blob's own timer or a guest in a channel cannot start a session. On, they can ask, and the computer still asks you first, or your approval queue does if you set it to."
      >
        <Switch label="Work you did not start may use a computer" on={settings.unattended} onChange={(on) => onChange({ unattended: on })} />
      </FieldRow>
    </div>
  );
}

/** Whether a device app behind KOS's build updates on its own. */
function UpdateRules({ settings, onChange }: { settings: ComputerSettings; onChange: (patch: Partial<ComputerSettings>) => void }): ReactElement {
  return (
    <div className="set-group device-rules">
      <h2>Updates</h2>
      <FieldRow
        label="Update devices on their own"
        hint="KOS for Chrome reloads itself into KOS's new build once its side panel is idle. KOS for Mac on this computer is rebuilt and reopened once it is idle, and only when your signing key is set up, so it keeps its permissions. KOS for iPhone updates from Xcode; it says when one is ready."
      >
        <Switch label="Update devices on their own" on={settings.autoUpdate} onChange={(on) => onChange({ autoUpdate: on })} />
      </FieldRow>
    </div>
  );
}

/**
 * Phones on the home Wi-Fi: off until the owner turns it on. On, KOS opens a
 * listener of its own for them, which pairs and carries the device socket and
 * nothing else; the dashboard stays on this computer alone.
 */
/** Said in every state: the pairing page is anyone's on the network who looks. */
const SHARED_WIFI = "Anyone on the same Wi-Fi can reach its pairing page while it is on, so leave it off on a shared network.";

function PhoneRules({ settings, lan, onChange }: { settings: ComputerSettings; lan: LanStatus | undefined; onChange: (patch: Partial<ComputerSettings>) => void }): ReactElement {
  const on = settings.lan || lan?.forced === true;
  const where = lan?.on ? `${lan.urls.join(", ") || `port ${lan.port}, but this computer has no address on a home network`}. Your iPhone checks KOS shows ${lan.words}.` : undefined;
  return (
    <div className="set-group device-rules">
      <h2>Phones</h2>
      <FieldRow
        label="Phones on this Wi-Fi"
        hint={
          lan?.error ??
          `${
            lan?.forced
              ? `On, set by KOS_DEVICE_LAN on the host. ${where ?? ""}`
              : on
                ? `KOS for iPhone reaches KOS at ${where ?? "its own address."} Only pairing and the device line answer there; the dashboard stays on this computer.`
                : "Off by default. On, KOS for iPhone on your home Wi-Fi can pair and chat with KOS over a line of its own, encrypted and pinned at pairing; the dashboard stays on this computer."
          } ${SHARED_WIFI}`
        }
      >
        <Switch label="Phones on this Wi-Fi" on={on} disabled={lan?.forced === true} onChange={(next) => onChange({ lan: next })} />
      </FieldRow>
    </div>
  );
}

/**
 * One of the APNs key's names, saved when the owner leaves the field.
 *
 * A new saved value replaces the draft only while the owner has no edit of
 * their own in it, and during render rather than in an effect: an effect
 * that copied the value in could run after the first keystroke and erase it.
 */
function PushText({ label, hint, field, value, placeholder, disabled, onSave }: { label: string; hint: string; field: keyof PushSettings; value: string; placeholder: string; disabled: boolean; onSave: (patch: Partial<PushSettings>) => void }): ReactElement {
  const [draft, setDraft] = useState(value);
  const [synced, setSynced] = useState(value);
  if (value !== synced) {
    setSynced(value);
    if (draft === synced) setDraft(value);
  }
  const save = (): void => {
    const next = draft.trim();
    setDraft(next);
    if (next !== value) onSave({ [field]: next });
  };
  return (
    <Field className="set-field" label={label} hint={hint}>
      <input
        className="kos-input"
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
        }}
      />
    </Field>
  );
}

/** Where push stands, in the owner's words: what is wrong, where it is set, or that it is on. */
export function pushStanding(push: PushStatus): string {
  if (push.problem) return push.problem;
  if (push.configured) return push.source === "env" ? "On, set when KOS was started. Each iPhone with notifications on gets KOS's asks, to approve or deny from the lock screen." : "On. Each iPhone with notifications on gets KOS's asks, to approve or deny from the lock screen.";
  return "Off. To get KOS's asks on an iPhone's lock screen, you need an Apple developer account and a push key from Apple; the fields below say where each part comes from.";
}

/**
 * Asks pushed to phones: the APNs key's id, the team, the app's bundle id,
 * and the vault secret that holds the .p8. The key itself is added on the
 * Secrets page, as a note, so it is sealed, scrubbed and never shown again.
 */
function PushRules({ push, onSave }: { push: PushStatus; onSave: (patch: Partial<PushSettings>) => void }): ReactElement {
  const [secrets, setSecrets] = useState<SecretSummary[]>([]);
  useEffect(() => {
    void secretsApi.list().then((all) => setSecrets(all.filter((s) => s.source === "vault" && (s.kind === "note" || s.kind === "apikey"))), () => setSecrets([]));
  }, []);
  const fromEnv = push.source === "env";
  const p = push.settings;
  const options = [{ value: "", label: "None" }, ...secrets.map((s) => ({ value: s.handle, label: s.label, hint: s.handle }))];
  if (p.secret && !secrets.some((s) => s.handle === p.secret)) options.push({ value: p.secret, label: p.secret, hint: "not in the vault" });
  return (
    <div className="set-group device-rules">
      <h2>Phone notifications</h2>
      <p className="hint" data-field="Phone notifications">{pushStanding(push)}</p>
      <Field group className="set-field" label="APNs key" hint="The .p8 file's text, added on the Secrets page as a note. KOS reads it from the vault to sign each push and never shows it.">
        <Select label="APNs key" value={p.secret} options={options} disabled={fromEnv} onChange={(secret) => onSave({ secret })} />
      </Field>
      <PushText label="Key ID" field="keyId" value={p.keyId} placeholder="ABC123DEFG" disabled={fromEnv} onSave={onSave} hint="The 10 letters and digits Apple shows beside the key." />
      <PushText label="Team ID" field="teamId" value={p.teamId} placeholder="DEF123GHIJ" disabled={fromEnv} onSave={onSave} hint="Your Apple developer team's, under Membership." />
      <PushText label="Bundle ID" field="topic" value={p.topic} placeholder="com.you.kos-phone" disabled={fromEnv} onSave={onSave} hint="KOS for iPhone's, as its Xcode target signs it." />
    </div>
  );
}

/** A phone's notifications, in a few words: on, off on the phone, or waiting on KOS's APNs key. */
export function pushWords(d: PairedDevice, push: PushStatus | undefined): string | undefined {
  if (d.kind !== "phone" || !push) return undefined;
  if (!push.configured) return d.push?.on ? "Push ready on the iPhone; KOS has no APNs key yet" : "Push not configured";
  if (!d.push?.on) return "Push off: turn on notifications in KOS for iPhone's Settings";
  return d.push.env === "sandbox" ? "Push on, a build from Xcode" : "Push on";
}

/** The link KOS for iPhone pairs from: the Wi-Fi address, the code, and the certificate it pins. */
export function phoneLink(url: string, code: string, pin: string): string {
  return `${pairingLink(url, code)}&pin=${encodeURIComponent(pin)}`;
}

/** The link KOS for Mac opens itself on, with this dashboard's address in it. */
export function pairingLink(origin: string, code: string): string {
  return `kos-device://pair?url=${encodeURIComponent(origin)}&code=${encodeURIComponent(code)}`;
}

function platformName(platform: string): string {
  return platform === "macos" ? "macOS" : platform === "chrome" ? "Chrome" : platform === "ios" ? "iOS" : platform;
}

/** What is missing for KOS to use it, in the owner's words. */
function missing(d: PairedDevice): string | undefined {
  if (!d.permissions || d.kind !== "computer") return undefined;
  const lacks = [!d.permissions.screen && "Screen Recording", !d.permissions.input && "Accessibility"].filter(Boolean);
  return lacks.length ? `Needs ${lacks.join(" and ")} on the computer` : undefined;
}

/** The build a device runs, in a few words: its commit (its id when built outside a checkout) and when it was built. */
export function buildWords(build: DeviceBuild | undefined, now = Date.now()): string {
  if (!build) return "Build unknown";
  const short = build.commit ? build.commit.slice(0, 7) : build.id;
  return build.builtAt ? `Build ${short}, built ${timeWords(build.builtAt, now)}` : `Build ${short}`;
}

/** Where a device's build stands with KOS's, as a pill, and why when it is not up to date. */
export function updateWords(d: PairedDevice): { pill: string; tone: Tone; why?: string } | undefined {
  const u = d.update;
  if (!u) return undefined;
  const mac = d.kind === "computer";
  const app = d.kind === "browser" ? "KOS for Chrome" : mac ? "KOS for Mac" : "KOS for iPhone";
  if (u.state === "current") return { pill: "Up to date", tone: "ok" };
  if (u.state === "updating") return { pill: "Updating", tone: "accent", why: mac ? "Rebuilding and reopening KOS for Mac" : "Reloading into KOS's build" };
  if (u.state === "unknown") {
    return {
      pill: "Build unknown",
      tone: "muted",
      why: u.reason === "unbuilt" ? `KOS has no build of ${app} to compare with; build KOS (pnpm build)` : `This ${app} is from before builds were stamped${mac ? "; Update now rebuilds it" : "; update it once by hand"}`,
    };
  }
  const why = {
    idle: mac ? "Waiting until no session or turn is on the Mac" : "Reloads once its side panel is idle",
    signing: "Signing is not set up, so an update here would ask for Screen Recording and Accessibility again. Set it up once, or Update anyway",
    xcode: "Run KOS for iPhone again from Xcode on your Mac",
    remote: "On another computer: update it there",
    unproved: u.detail ?? "KOS can't tell this Mac is its own",
    store: "Installed from the store; Chrome updates it",
    off: "Updating on their own is off",
    failed: `The update did not finish${u.detail ? `: ${u.detail}` : ""}`,
    stuck: mac ? "Rebuilt, and still on the old build" : "Still on the old build: is it loaded from this KOS's packages/browser-extension/dist?",
    unbuilt: undefined,
    unstamped: undefined,
  }[u.reason ?? "idle"];
  return { pill: "Behind", tone: "warn", ...(why ? { why } : {}) };
}

/** Whether Update now can do anything for it: a Chrome or a Mac on this computer that KOS has a newer build for. */
export function canUpdate(d: PairedDevice): boolean {
  const u = d.update;
  if (!u || !d.online || d.kind === "phone" || u.reason === "remote" || u.reason === "unproved" || u.reason === "store" || u.reason === "unbuilt") return false;
  return u.state === "behind" || (d.kind === "computer" && u.state === "unknown" && u.reason === "unstamped" && d.local === true);
}

export function describeDevice(d: PairedDevice, now = Date.now()): string {
  const browser = d.kind === "browser";
  if (d.kind === "phone") {
    const seen = d.online ? "online" : d.lastSeen ? `offline, last seen ${timeWords(d.lastSeen, now)}` : "never connected";
    return `Your phone${d.os ? `, iOS ${d.os}` : ""}, through KOS for iPhone · chat only, no computer use · ${seen}`;
  }
  if (!d.online) return d.lastSeen ? `Offline, last seen ${timeWords(d.lastSeen, now)}` : browser ? "Never connected. Pair it from KOS for Chrome." : "Never connected. Open KOS for Mac on it.";
  const parts = [
    browser
      ? `Your own Chrome${d.os ? ` on ${d.os}` : ""}, through KOS for Chrome; not KOS's browser`
      : `Your computer${[platformName(d.platform), d.os].filter(Boolean).length ? `, ${[platformName(d.platform), d.os].filter(Boolean).join(" ")}` : ""}, through KOS for Mac`,
    browser ? "asks in Chrome" : d.consent === "kos" ? "starts through your approvals" : "asks on the computer",
    missing(d),
  ].filter(Boolean);
  if (d.session) {
    const until = new Date(d.session.until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const where = d.session.target?.kind === "window" ? `, in ${d.session.target.app ?? "one window"}` : "";
    parts.push(`${d.session.paused ? "Paused by you" : "In use"}: ${d.session.title}, "${d.session.task}"${where}, until ${until}`);
  }
  return parts.join(" · ");
}

function DeviceRow({ device, push, onChanged }: { device: PairedDevice; push: PushStatus | undefined; onChanged: () => void }): ReactElement {
  const [name, setName] = useState<string | null>(null);
  const save = (): void => {
    const next = name?.trim();
    setName(null);
    if (next && next !== device.name) void api.renameDevice(device.id, next).then(onChanged, onChanged);
  };
  const state = device.session ? (
    <Pill tone={device.session.paused ? "warn" : "accent"}>{device.session.paused ? "paused" : "in use"}</Pill>
  ) : (
    <Pill tone={device.online ? "ok" : "muted"}>{device.online ? "online" : "offline"}</Pill>
  );
  const update = updateWords(device);
  const badge = (
    <>
      {state}
      {update && <Pill tone={update.tone}>{update.pill}</Pill>}
    </>
  );
  // Its build and where that stands, never folded away: the reason is what the owner acts on.
  const note = [...(device.online ? [buildWords(device.build), update?.why] : []), pushWords(device, push)].filter(Boolean).join(" · ") || undefined;
  const command = device.online ? device.update?.command : undefined;
  return (
    <FieldRow label={device.name} badge={badge} hint={describeDevice(device)} {...(note ? { note } : {})} {...(command ? { after: <CommandLine command={command} /> } : {})}>
      {name !== null ? (
        <input
          className="kos-input"
          value={name}
          autoFocus
          aria-label="Device name"
          onChange={(e) => setName(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") setName(null);
          }}
        />
      ) : (
        <div className="set-inline">
          {device.session && (
            <button type="button" className="btn btn--sm" onClick={() => void api.stopDevice(device.id).then(onChanged, onChanged)}>
              Stop
            </button>
          )}
          {canUpdate(device) && (
            <button type="button" className="btn btn--sm" onClick={() => void api.updateDevice(device.id).then(onChanged, onChanged)}>
              {device.update?.reason === "signing" ? "Update anyway" : "Update now"}
            </button>
          )}
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setName(device.name)}>
            Rename
          </button>
          <ConfirmButton
            label="Remove"
            text={`Unpair ${device.name}? KOS forgets its key and cannot use it until you pair it again.`}
            onConfirm={() => void api.removeDevice(device.id).then(onChanged, onChanged)}
          />
        </div>
      )}
    </FieldRow>
  );
}

/**
 * Where the two apps come from, for an owner who has neither: both are built
 * from KOS's own folder, so each is one step there, said as the command to run.
 */
function GetTheApps(): ReactElement {
  return (
    <div className="set-group device-get">
      <h2>Get the apps</h2>
      <p className="hint">KOS for Mac lets KOS work a Mac. Build it once, in Terminal, from KOS's folder:</p>
      <CommandLine command="packages/device-macos/scripts/bundle.sh --install" />
      <p className="hint">
        KOS for Chrome lets KOS work in tabs of your own Chrome. Open chrome://extensions, turn on Developer mode, press Load unpacked, and pick the
        packages/browser-extension/dist folder in KOS's folder.
      </p>
    </div>
  );
}

function PairingCode({ code, now, onDone }: { code: DeviceCode; now: number; onDone: () => void }): ReactElement {
  const origin = window.location.origin;
  const link = pairingLink(origin, code.code);
  const left = Math.max(0, Math.ceil((code.expiresAt - now) / 60_000));
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (what: string, text: string): void => {
    void navigator.clipboard.writeText(text).then(() => setCopied(what));
  };
  return (
    <div className="device-pair">
      <p className="device-code" aria-label="Pairing code">
        {code.code}
      </p>
      <p className="hint">
        {left > 0
          ? `This code works once, for ${left} more minute${left === 1 ? "" : "s"}.`
          : "This code has expired. Make another."}
      </p>
      {left > 0 && (
        <ol className="device-steps hint">
          <li>On this Mac: press Open KOS for Mac below, and it pairs on its own.</li>
          <li>On another Mac: open KOS for Mac, choose Add a KOS, and paste the link from Copy link. Or type this KOS's address, {origin}, and the code.</li>
          <li>In Chrome: open KOS for Chrome from the toolbar, choose Add a KOS, and paste the same link.</li>
        </ol>
      )}
      {code.lan && left > 0 && (
        <p className="hint">
          On an iPhone on this Wi-Fi, paste the phone link into KOS for iPhone, or enter {code.lan.url} and this code. Check your iPhone shows{" "}
          <strong>{code.lan.words}</strong> before you pair.
        </p>
      )}
      <div className="set-inline">
        <a className="btn btn--primary btn--sm" href={link}>
          Open KOS for Mac
        </a>
        <button type="button" className="btn btn--sm" onClick={() => copy("link", link)}>
          {copied === "link" ? "Link copied" : "Copy link"}
        </button>
        {code.lan && (
          <button type="button" className="btn btn--sm" onClick={() => copy("phone", phoneLink(code.lan!.url, code.code, code.lan!.pin))}>
            {copied === "phone" ? "Phone link copied" : "Copy phone link"}
          </button>
        )}
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => copy("code", code.code)}>
          {copied === "code" ? "Code copied" : "Copy code"}
        </button>
        <button type="button" className="btn btn--sm btn--ghost" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

export function DevicesPanel(): ReactElement {
  const [devices, setDevices] = useState<PairedDevice[] | null>(null);
  const [settings, setSettings] = useState<ComputerSettings | null>(null);
  const [lan, setLan] = useState<LanStatus | undefined>(undefined);
  const [push, setPush] = useState<PushStatus | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<DeviceCode | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [joined, setJoined] = useState<string | null>(null);
  const known = useRef<Set<string> | null>(null);

  const load = useCallback(() => {
    void api.devices().then(
      (r) => {
        setError(null);
        setDevices(r.devices);
        setSettings(r.settings);
        setLan(r.lan);
        setPush(r.push);
        // A device that appears while a code is up is the one that used it.
        const before = known.current;
        known.current = new Set(r.devices.map((d) => d.id));
        const fresh = before ? r.devices.find((d) => !before.has(d.id)) : undefined;
        if (fresh) {
          setCode(null);
          setJoined(fresh.name);
        }
      },
      (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    );
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(() => {
      load();
      setNow(Date.now());
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const change = (patch: Partial<ComputerSettings>): void => {
    if (settings) setSettings({ ...settings, ...patch });
    void api.setComputerSettings(patch).then(
      (next) => {
        setSettings(next);
        // The listener follows the setting at once; its address and words come with the next read.
        if (patch.lan !== undefined) load();
      },
      (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    );
  };

  const savePush = (patch: Partial<PushSettings>): void => {
    void api.setPush(patch).then(setPush, (err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  const add = (): void => {
    setJoined(null);
    void api.deviceCode().then(setCode, (err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  if (error) return <p className="hint">{error}</p>;
  if (!devices) return <p className="hint">Loading…</p>;
  return (
    <>
      {devices.length === 0 && !code && (
        <EmptyState variant="inline">Nothing paired yet. Get KOS for Mac or KOS for Chrome below, then press Add a device.</EmptyState>
      )}
      {devices.length === 0 && !code && <GetTheApps />}
      {joined && <p className="hint">Paired {joined}.</p>}
      <div className="set-rows">
        {devices.map((d) => (
          <DeviceRow key={d.id} device={d} push={push} onChanged={load} />
        ))}
      </div>
      {code ? (
        <PairingCode code={code} now={now} onDone={() => setCode(null)} />
      ) : (
        <div className="set-inline" data-field="Add a device">
          <button type="button" className="btn btn--sm" onClick={add}>
            Add a device
          </button>
        </div>
      )}
      {settings && <SessionRules settings={settings} onChange={change} />}
      {settings && <PhoneRules settings={settings} lan={lan} onChange={change} />}
      {push && (
        <details className="settings-more" open={push.configured || Boolean(push.problem)}>
          <summary>Advanced: phone notifications</summary>
          <PushRules push={push} onSave={savePush} />
        </details>
      )}
      {settings && <UpdateRules settings={settings} onChange={change} />}
    </>
  );
}
