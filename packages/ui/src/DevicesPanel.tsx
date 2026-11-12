import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { Empty, Field, Pill, Switch } from "@kos/kit";

import { api, type ComputerSettings, type DeviceCode, type LanStatus, type PairedDevice } from "./api.js";
import { ConfirmButton, FieldRow } from "./kit.js";
import { agoWords } from "./schedulewords.js";
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
      <h3>Sessions</h3>
      <Field group className="set-field" label="KOS asks for" hint="How long a session KOS asks for when the chat does not say. Each computer can allow less: its own longest session wins.">
        <Select
          label="KOS asks for"
          value={String(settings.askMinutes)}
          options={options.map((m) => ({ value: String(m), label: minutesLabel(m) }))}
          onChange={(v) => onChange({ askMinutes: Number(v) })}
        />
      </Field>
      <Field group className="set-field"
        label="Work you did not start may use a computer"
        hint="Off by default: a schedule, a blob's own timer or a guest in a channel cannot start a session. On, they can ask, and the computer still asks you first, or your approval queue does if you set it to."
      >
        <Switch label="Work you did not start may use a computer" on={settings.unattended} onChange={(on) => onChange({ unattended: on })} />
      </Field>
    </div>
  );
}

/**
 * Phones on the home Wi-Fi: off until the owner turns it on. On, KOS opens a
 * listener of its own for them, which pairs and carries the device socket and
 * nothing else; the dashboard stays on this computer alone.
 */
function PhoneRules({ settings, lan, onChange }: { settings: ComputerSettings; lan: LanStatus | undefined; onChange: (patch: Partial<ComputerSettings>) => void }): ReactElement {
  const on = settings.lan || lan?.forced === true;
  const where = lan?.on ? `${lan.urls.join(", ") || `port ${lan.port}, but this computer has no address on a home network`}. Your iPhone checks KOS shows ${lan.words}.` : undefined;
  return (
    <div className="set-group device-rules">
      <h3>Phones</h3>
      <Field group className="set-field"
        label="Phones on this Wi-Fi"
        hint={
          lan?.error ??
          (lan?.forced
            ? `On, set by KOS_DEVICE_LAN on the host. ${where ?? ""}`
            : on
              ? `KOS for iPhone reaches KOS at ${where ?? "its own address."} Only pairing and the device line answer there; the dashboard stays on this computer.`
              : "Off by default. On, KOS for iPhone on your home Wi-Fi can pair and chat with KOS over a line of its own, encrypted and pinned at pairing; the dashboard stays on this computer.")
        }
      >
        <Switch label="Phones on this Wi-Fi" on={on} disabled={lan?.forced === true} onChange={(next) => onChange({ lan: next })} />
      </Field>
    </div>
  );
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

export function describeDevice(d: PairedDevice, now = Date.now()): string {
  const browser = d.kind === "browser";
  if (d.kind === "phone") {
    const seen = d.online ? "online" : d.lastSeen ? `offline, last seen ${agoWords(d.lastSeen, now)}` : "never connected";
    return `Your phone${d.os ? `, iOS ${d.os}` : ""}, through KOS for iPhone · chat only, no computer use · ${seen}`;
  }
  if (!d.online) return d.lastSeen ? `Offline, last seen ${agoWords(d.lastSeen, now)}` : browser ? "Never connected. Pair it from KOS for Chrome." : "Never connected. Open KOS for Mac on it.";
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

function DeviceRow({ device, onChanged }: { device: PairedDevice; onChanged: () => void }): ReactElement {
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
  return (
    <FieldRow label={device.name} badge={state} hint={describeDevice(device)}>
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
          ? `On a Mac, open KOS for Mac and paste the link, or enter ${origin} and this code. In Chrome, paste the link into KOS for Chrome. Good for ${left} more minute${left === 1 ? "" : "s"}, once.`
          : "This code has expired. Make another."}
      </p>
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

  const add = (): void => {
    setJoined(null);
    void api.deviceCode().then(setCode, (err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  if (error) return <p className="hint">{error}</p>;
  if (!devices) return <p className="hint">Loading…</p>;
  return (
    <>
      {devices.length === 0 && !code && (
        <Empty inline>Nothing paired yet. Install KOS for Mac on a Mac or KOS for Chrome in Chrome, then add it here.</Empty>
      )}
      {joined && <p className="hint">Paired {joined}.</p>}
      <div className="set-rows">
        {devices.map((d) => (
          <DeviceRow key={d.id} device={d} onChanged={load} />
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
    </>
  );
}
