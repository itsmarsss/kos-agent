import { useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";

import { Field } from "./Field.js";
import { Tag } from "./kit.js";

/**
 * The two pieces a secret is edited with. A secret's value goes one way:
 * typed into a SecretField, read from the form on submit, cleared. It is
 * never held in React state, never drawn back, never prefilled; what an
 * existing one shows is its hint ("•••• 4242").
 */

export interface SecretFieldProps {
  label: string;
  /** The form field's name: what `takeSecretValues` keys the value by. */
  name: string;
  /** What is kept already, said safely: "•••• 4242". */
  hint?: string;
  /** A value is kept already, so a blank means unchanged. */
  set?: boolean;
  /** Not a secret to look at (a username, an expiry): shown as typed, still write-only. */
  plain?: boolean;
  multiline?: boolean;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  inputMode?: "text" | "numeric";
  /** Put in the field once, on mount, from what the owner just typed elsewhere; never from the server. */
  seed?: string;
  autoFocus?: boolean;
  help?: ReactNode;
}

/** Where a SecretField is in the DOM, so a form's values can be read and cleared without passing through state. */
const SECRET_ATTR = "data-secret";

/**
 * A secret's value, masked as it is typed. Blank means unchanged when one
 * is kept; paste works; the browser is told not to remember, fill or check it.
 */
export function SecretField({ label, name, hint, set = false, plain = false, multiline = false, required = false, disabled = false, placeholder, inputMode, seed, autoFocus, help }: SecretFieldProps): ReactElement {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (seed && ref.current) ref.current.value = seed;
    // Once: the seed is a hand-off, not a binding.
  }, []);
  const shown = placeholder ?? (set ? (hint ? `Unchanged (${hint})` : "Unchanged") : "");
  const common = {
    ref,
    name,
    [SECRET_ATTR]: "",
    className: `kos-input secret-input${plain ? "" : " secret-input--masked"}`,
    autoComplete: "off",
    spellCheck: false,
    autoCapitalize: "off",
    autoCorrect: "off",
    "data-1p-ignore": "",
    "data-lpignore": "true",
    placeholder: shown,
    disabled,
    autoFocus,
    required: required && !set,
  } as const;
  return (
    <Field label={label} required={required && !set} hint={help}>
      {multiline ? <textarea rows={3} {...common} /> : <input type={plain ? "text" : "password"} inputMode={inputMode} {...common} />}
    </Field>
  );
}

/**
 * The values typed into a form's SecretFields, by name, the blank ones
 * left out; the fields are cleared as they are read, so the value lives
 * only in the request it is sent in.
 */
export function takeSecretValues(form: HTMLFormElement): Record<string, string> {
  const out: Record<string, string> = {};
  for (const el of Array.from(form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(`[${SECRET_ATTR}]`))) {
    if (el.value !== "") out[el.name] = el.value;
    el.value = "";
  }
  return out;
}

/** What an OriginList holds: web origins, bare API hosts, or Mac bundle ids. */
export type OriginMode = "origin" | "host" | "bundle";

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN = new RegExp(`^(\\*\\.)?(${LABEL}(?:\\.${LABEL})*)$`);
const BUNDLE = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

function checkDomain(host: string): string | null {
  const m = DOMAIN.exec(host);
  if (!m) return "Not a host name.";
  if (m[1] && !m[2]!.includes(".")) return "A wildcard needs a domain under it: *.example.com.";
  return null;
}

/**
 * An origin, host or bundle id as kept, or why it cannot be. Origins are
 * https, exact or one wildcard label (https://*.example.com), with only
 * http://localhost let through plain; no path.
 */
export function checkOrigin(text: string, mode: OriginMode = "origin"): { ok: string } | { error: string } {
  const typed = text.trim();
  if (!typed) return { error: "Empty." };
  if (mode === "bundle") return BUNDLE.test(typed) ? { ok: typed } : { error: "A bundle id looks like com.example.app." };
  const lower = typed.toLowerCase().replace(/\/+$/, "");
  if (mode === "host") {
    const host = lower.replace(/^https?:\/\//, "");
    const bad = checkDomain(host);
    return bad ? { error: bad } : { ok: host };
  }
  const m = /^([a-z]+):\/\/([^/:?#]+)(:\d{1,5})?$/.exec(lower);
  if (!m) return { error: lower.includes("://") ? "An origin has no path: https://example.com." : "Start with https://." };
  const [, scheme, host, port = ""] = m;
  if (scheme === "http" && host !== "localhost") return { error: "Only https, or http://localhost." };
  if (scheme !== "https" && scheme !== "http") return { error: "Only https, or http://localhost." };
  const bad = checkDomain(host!);
  if (bad) return { error: bad };
  if (port && Number(port.slice(1)) > 65535) return { error: "No such port." };
  return { ok: `${scheme}://${host}${port}` };
}

/** Payment providers' card frames, offered as ticks under a card's frames. */
export const PAYMENT_FRAMES: readonly { origin: string; label: string }[] = [
  { origin: "https://js.stripe.com", label: "Stripe" },
  { origin: "https://checkout.stripe.com", label: "Stripe Checkout" },
  { origin: "https://www.paypal.com", label: "PayPal" },
  { origin: "https://*.braintreegateway.com", label: "Braintree" },
  { origin: "https://*.adyen.com", label: "Adyen" },
  { origin: "https://*.checkout.com", label: "Checkout.com" },
  { origin: "https://*.squareup.com", label: "Square" },
  { origin: "https://*.klarna.com", label: "Klarna" },
];

const PLACEHOLDER: Record<OriginMode, string> = {
  origin: "https://example.com",
  host: "api.example.com",
  bundle: "com.example.app",
};

export interface OriginListProps {
  label: string;
  value: readonly string[];
  onChange: (next: string[]) => void;
  mode?: OriginMode;
  /** Common ones to tick, each kept as its origin when ticked. */
  presets?: readonly { origin: string; label: string }[];
  hint?: ReactNode;
  disabled?: boolean;
}

/**
 * Where something may be used, as a list to add to and take from: each
 * entry a Tag with its ×, a field to add one checked as it is added, and
 * common ones as ticks.
 */
export function OriginList({ label, value, onChange, mode = "origin", presets = [], hint, disabled = false }: OriginListProps): ReactElement {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const preset = new Set(presets.map((p) => p.origin));
  const own = value.filter((v) => !preset.has(v));

  const add = (): void => {
    const checked = checkOrigin(draft, mode);
    if ("error" in checked) {
      setError(checked.error);
      return;
    }
    if (!value.includes(checked.ok)) onChange([...value, checked.ok]);
    setDraft("");
    setError(null);
  };
  const toggle = (origin: string, on: boolean): void => onChange(on ? [...value, origin] : value.filter((v) => v !== origin));

  return (
    <Field label={label} group hint={hint} error={error}>
      {presets.length > 0 && (
        <div className="origin-ticks">
          {presets.map((p) => (
            <label key={p.origin} className="origin-tick">
              <input type="checkbox" className="kos-check" checked={value.includes(p.origin)} disabled={disabled} onChange={(e) => toggle(p.origin, e.target.checked)} />
              <span>{p.label}</span>
              <span className="origin-tick-origin">{p.origin.replace(/^https:\/\//, "")}</span>
            </label>
          ))}
        </div>
      )}
      {own.length > 0 && (
        <div className="origin-items">
          {own.map((v) => (
            <Tag key={v} mono {...(disabled ? {} : { remove: { label: `Remove ${v}`, onRemove: () => onChange(value.filter((x) => x !== v)) } })}>
              {v}
            </Tag>
          ))}
        </div>
      )}
      {!disabled && (
        <div className="origin-add">
          <input
            className="kos-input kos-mono"
            value={draft}
            placeholder={PLACEHOLDER[mode]}
            aria-label={`Add to ${label}`}
            aria-invalid={error ? true : undefined}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
          />
          <button type="button" className="btn" disabled={!draft.trim()} onClick={add}>
            Add
          </button>
        </div>
      )}
    </Field>
  );
}
