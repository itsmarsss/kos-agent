import { useEffect, useRef, useState, type FormEvent, type ReactElement } from "react";

import { Chips, Empty, Field, OriginList, PAYMENT_FRAMES, Pill, SecretField, Section, Switch, Tag, takeSecretValues, type Tone } from "@kos/kit";

import { Drawer } from "./Drawer.js";
import { ConfirmButton } from "./kit.js";
import { agoWords } from "./schedulewords.js";
import { SECRET_KINDS, type SecretBilling, type SecretFieldName, type SecretKind, type SecretSummary, type SecretUse, type SecretUseRow, type SecretValues, type VaultStatus } from "@kos/shared";

import {
  ASK_WORDS,
  BILLING_PARTS,
  defaultPolicy,
  emptyUse,
  FIELD_LABEL,
  KINDS,
  secretsApi,
  SURFACE_WORDS,
  refusal,
  type SecretDraft,
} from "./secrets.js";

/** What the owner typed elsewhere (the composer) to start a new secret with; held by the opener, never in a URL. */
export interface SecretSeed {
  kind: SecretKind;
  field: SecretFieldName;
  value: string;
}

export type SecretSheetMode = { kind: "add"; seed?: SecretSeed } | { kind: "edit"; secret: SecretSummary };

const FORM_ID = "secret-form";
/** How long a revealed value stays on screen. */
export const REVEAL_MS = 30_000;

const OUTCOME_TONE = (outcome: string): Tone => (outcome === "filled" ? "ok" : outcome === "expired" ? "muted" : outcome === "failed" ? "warn" : "danger");

/**
 * A secret, added or edited, in a sheet from the right: its label, its
 * values (write-only), where it may be used, when KOS must ask; for one
 * kept already, its grants, its uses, a reveal and delete. An env secret
 * is shown and not changed.
 */
export function SecretSheet({
  open,
  mode,
  status,
  conversations = [],
  onClose,
  onSaved,
  onDeleted,
}: {
  open: boolean;
  mode: SecretSheetMode;
  status?: VaultStatus | null;
  /** Chats a secret can be limited to. */
  conversations?: readonly { id: string; title: string }[];
  onClose: () => void;
  onSaved: (secret: SecretSummary | { handle: string }) => void;
  onDeleted?: (handle: string) => void;
}): ReactElement {
  const editing = mode.kind === "edit" ? mode.secret : null;
  const title = editing ? editing.label : "New secret";
  const sub = editing ? `${KINDS[editing.kind].label} · ${editing.handle}` : "KOS can use it without seeing it";
  const readOnly = editing?.source === "env";
  const [deleteError, setDeleteError] = useState<string | null>(null);
  return (
    <Drawer
      open={open}
      title={title}
      subtitle={sub}
      onClose={onClose}
      footer={
        readOnly ? undefined : (
          <>
            <button type="submit" form={FORM_ID} className="btn btn--primary">
              {editing ? "Save" : "Add secret"}
            </button>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            {editing && onDeleted && (
              <span className="secret-foot-end">
                <ConfirmButton
                  label="Delete"
                  className="btn btn--danger"
                  text={`Delete ${editing.label}? KOS can no longer use it, and this cannot be undone.`}
                  onConfirm={() =>
                    void secretsApi
                      .remove(editing.handle)
                      .then(() => onDeleted(editing.handle))
                      .catch((err: unknown) => setDeleteError(refusal(err)))
                  }
                />
              </span>
            )}
            {deleteError && (
              <span className="field-error" role="alert">
                {deleteError}
              </span>
            )}
          </>
        )
      }
    >
      <SheetBody key={editing?.handle ?? "new"} mode={mode} status={status ?? null} conversations={conversations} onSaved={onSaved} />
    </Drawer>
  );
}

function SheetBody({ mode, status, conversations, onSaved }: { mode: SecretSheetMode; status: VaultStatus | null; conversations: readonly { id: string; title: string }[]; onSaved: (secret: SecretSummary | { handle: string }) => void }): ReactElement {
  const editing = mode.kind === "edit" ? mode.secret : null;
  const seed = mode.kind === "add" ? mode.seed : undefined;
  const readOnly = editing?.source === "env";
  const [summary, setSummary] = useState<SecretSummary | null>(editing);
  const [label, setLabel] = useState(editing?.label ?? "");
  const [kind, setKind] = useState<SecretKind>(editing?.kind ?? seed?.kind ?? "login");
  const [use, setUse] = useState<SecretUse>(editing?.use ?? emptyUse());
  const [policy, setPolicy] = useState<SecretDraft["policy"]>(editing ? { ask: editing.policy.ask, unattended: editing.policy.unattended, chats: editing.policy.chats } : defaultPolicy());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (saving || readOnly) return;
    if (!label.trim()) {
      setError("Give it a label.");
      return;
    }
    // Read from the fields and cleared at once: the values live only in the request below.
    const values = valuesOf(takeSecretValues(e.currentTarget));
    // An API key's hosts go with the way it is sent; the chips show bearer until another is chosen, so bearer is what is saved.
    const sent: SecretUse = kind === "apikey" && use.http.hosts.length && !use.http.as ? { ...use, http: { ...use.http, as: "bearer" } } : use;
    setSaving(true);
    setError(null);
    try {
      if (editing) {
        const saved = await secretsApi.update(editing.handle, {
          label: label.trim(),
          ...(Object.keys(values).length ? { values } : {}),
          use: sent,
          policy: { ...policy, grants: summary?.policy.grants ?? [] },
        });
        onSaved(saved);
      } else {
        onSaved(await secretsApi.create({ label: label.trim(), kind, values, use: sent, policy: { ...policy, grants: [] } }));
      }
    } catch (err) {
      setError(refusal(err));
    } finally {
      setSaving(false);
    }
  };

  const set = (field: SecretFieldName): boolean => editing?.fields.includes(field) ?? false;
  const hintFor = (field: SecretFieldName): string | undefined => (editing && field === editing.fields.find((f) => MAIN.has(f)) ? editing.hint : undefined);
  const seedFor = (field: SecretFieldName): string | undefined => (seed && seed.kind === kind && seed.field === field ? seed.value : undefined);
  const field = (name: SecretFieldName, extra: { plain?: boolean; multiline?: boolean; required?: boolean; inputMode?: "numeric"; placeholder?: string } = {}): ReactElement => {
    const s = seedFor(name);
    const h = hintFor(name);
    return <SecretField key={`${kind}-${name}`} label={FIELD_LABEL[name]} name={name} set={set(name)} disabled={readOnly} {...extra} {...(h ? { hint: h } : {})} {...(s ? { seed: s } : {})} />;
  };

  return (
    <div className="secret-sheet">
      <form id={FORM_ID} className="secret-form" onSubmit={(e) => void submit(e)} autoComplete="off" noValidate={readOnly}>
        {readOnly && <p className="set-note">From the environment, as {editing!.handle}. Change it where KOS is started; it cannot be edited here.</p>}
        <Field label="Label" required>
          <input className="kos-input" value={label} disabled={readOnly} placeholder="GitHub, Visa ending 4242" autoComplete="off" onChange={(e) => setLabel(e.target.value)} />
        </Field>
        {!editing && (
          <Field label="Kind" group>
            <Chips options={SECRET_KINDS.map((k) => [k, KINDS[k].label] as const)} selected={kind} onChoose={setKind} label="Kind" />
          </Field>
        )}

        <Section label="Values">
          <div className="secret-fields">
            {editing && !readOnly && <p className="hint secret-section-hint">What is kept is never shown here. A blank field keeps it; type to replace it.</p>}
            {kind === "login" && (
              <>
                {field("username", { plain: true })}
                {field("password", { required: true })}
              </>
            )}
            {kind === "card" && (
              <>
                {field("number", { required: true, inputMode: "numeric" })}
                <div className="secret-pair">
                  {field("expiry", { plain: true, placeholder: set("expiry") ? "Unchanged" : "MM/YY" })}
                  {field("cvc", { inputMode: "numeric" })}
                </div>
                {field("name", { plain: true })}
              </>
            )}
            {kind === "apikey" && (
              <>
                {field("token", { required: true })}
                {field("username", { plain: true, placeholder: set("username") ? "Unchanged" : "Only for basic auth" })}
              </>
            )}
            {kind === "note" && field("text", { required: true, multiline: true })}
          </div>
        </Section>

        {kind === "card" && (
          <Section label={FIELD_LABEL.billing}>
            <div className="secret-billing">
              {BILLING_PARTS.map((p) => (
                <SecretField key={p.key} label={p.label} name={`billing.${p.key}`} plain disabled={readOnly} {...(set("billing") ? { placeholder: "Unchanged" } : {})} />
              ))}
            </div>
            {set("billing") && <p className="hint secret-section-hint">Fill every part to replace the address.</p>}
          </Section>
        )}

        <Section label="Where it may be used">
          <div className="secret-fields">
            {kind === "apikey" ? (
              <>
                <OriginList label="API hosts" mode="host" value={use.http.hosts} disabled={readOnly} hint="Sent only in requests to these." onChange={(hosts) => setUse({ ...use, http: { ...use.http, hosts } })} />
                <Field label="Sent as" group>
                  <Chips
                    small
                    options={[["bearer", "Bearer token"], ["basic", "Basic auth"]] as const}
                    selected={use.http.as ?? "bearer"}
                    onChoose={(as) => !readOnly && setUse({ ...use, http: { ...use.http, as } })}
                    label="Sent as"
                  />
                </Field>
              </>
            ) : (
              <>
                <OriginList label="Sites" value={use.web.origins} disabled={readOnly} hint="Exact, or one level of wildcard: https://*.example.com." onChange={(origins) => setUse({ ...use, web: { ...use.web, origins } })} />
                <OriginList label="Frames" value={use.web.frames} disabled={readOnly} {...(kind === "card" ? { presets: PAYMENT_FRAMES } : {})} hint="Frames inside those sites it may be filled into, such as a payment form." onChange={(frames) => setUse({ ...use, web: { ...use.web, frames } })} />
              </>
            )}
            <OriginList label="Mac apps" mode="bundle" value={use.apps} disabled={readOnly} onChange={(apps) => setUse({ ...use, apps })} />
          </div>
        </Section>

        <Section label="When KOS asks">
          <div className="secret-fields">
            <Field label="Ask" group>
              <Chips small options={(Object.keys(ASK_WORDS) as SecretDraft["policy"]["ask"][]).map((a) => [a, ASK_WORDS[a]] as const)} selected={policy.ask} onChoose={(ask) => !readOnly && setPolicy({ ...policy, ask })} label="Ask" />
            </Field>
            <SwitchLine label="Usable with nobody watching" hint="Schedules, dispatches and timers." on={policy.unattended} disabled={readOnly} onChange={(unattended) => setPolicy({ ...policy, unattended })} />
            {policy.unattended && <p className="secret-warn" role="note">A run with nobody watching can use this secret and nobody is there to say no. Turn it on only for one a schedule needs.</p>}
            <SwitchLine label="Only in some chats" on={policy.chats !== null} disabled={readOnly} onChange={(on) => setPolicy({ ...policy, chats: on ? [] : null })} />
            {policy.chats !== null && <ChatPicks chosen={policy.chats} conversations={conversations} disabled={readOnly} onChange={(chats) => setPolicy({ ...policy, chats })} />}
          </div>
        </Section>
        {error && (
          <p className="ops-alert ops-alert--err" role="alert">
            {error}
          </p>
        )}
      </form>

      {summary && (
        <>
          <Grants secret={summary} disabled={readOnly} onChanged={setSummary} />
          {!readOnly && <Reveal secret={summary} status={status} />}
          <Uses handle={summary.handle} />
        </>
      )}
    </div>
  );
}

/** The field that carries a secret's hint. */
const MAIN = new Set<SecretFieldName>(["password", "number", "token", "text"]);

/** The typed values as the API takes them: billing's parts gathered into one, a card number's spaces gone. */
function valuesOf(typed: Record<string, string>): SecretValues {
  const out: SecretValues = {};
  const billing: SecretBilling = {};
  for (const [name, value] of Object.entries(typed)) {
    if (name.startsWith("billing.")) billing[name.slice(8) as keyof SecretBilling] = value;
    else out[name as Exclude<SecretFieldName, "billing">] = name === "number" ? value.replace(/[\s-]/g, "") : value;
  }
  if (Object.keys(billing).length) out.billing = billing;
  return out;
}

function SwitchLine({ label, hint, on, disabled, onChange }: { label: string; hint?: string; on: boolean; disabled?: boolean; onChange: (on: boolean) => void }): ReactElement {
  return (
    <div className="secret-switch">
      <span className="secret-switch-text">
        <span>{label}</span>
        {hint && <span className="hint">{hint}</span>}
      </span>
      <Switch on={on} onChange={onChange} label={label} {...(disabled ? { disabled } : {})} />
    </div>
  );
}

function ChatPicks({ chosen, conversations, disabled, onChange }: { chosen: string[]; conversations: readonly { id: string; title: string }[]; disabled: boolean; onChange: (chats: string[]) => void }): ReactElement {
  const known = new Set(conversations.map((c) => c.id));
  const others = chosen.filter((id) => !known.has(id));
  if (conversations.length === 0 && others.length === 0) return <Empty inline>No chats to choose from yet; until one is ticked, no chat can use it.</Empty>;
  return (
    <div className="origin-ticks">
      {conversations.map((c) => (
        <label key={c.id} className="origin-tick">
          <input type="checkbox" className="kos-check" disabled={disabled} checked={chosen.includes(c.id)} onChange={(e) => onChange(e.target.checked ? [...chosen, c.id] : chosen.filter((x) => x !== c.id))} />
          <span>{c.title}</span>
        </label>
      ))}
      {others.map((id) => (
        <Tag key={id} mono {...(disabled ? {} : { remove: { label: `Remove ${id}`, onRemove: () => onChange(chosen.filter((x) => x !== id)) } })}>
          {id}
        </Tag>
      ))}
    </div>
  );
}

function Grants({ secret, disabled, onChanged }: { secret: SecretSummary; disabled: boolean; onChanged: (s: SecretSummary) => void }): ReactElement | null {
  const [error, setError] = useState<string | null>(null);
  if (secret.policy.ask !== "site" && secret.policy.grants.length === 0) return null;
  return (
    <Section label="Remembered sites">
      {secret.policy.grants.length === 0 ? (
        <Empty inline>None yet. A yes you ask KOS to remember shows here.</Empty>
      ) : (
        <ul className="secret-lines">
          {secret.policy.grants.map((g) => (
            <li key={g.origin} className="secret-line">
              <span className="secret-line-main">{g.origin}</span>
              <span className="secret-line-meta">{agoWords(g.at)}</span>
              {!disabled && (
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() =>
                    void secretsApi
                      .revokeGrant(secret.handle, g.origin)
                      .then(onChanged)
                      .catch((err: unknown) => setError(refusal(err)))
                  }
                >
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="field-error">{error}</p>}
    </Section>
  );
}

function Uses({ handle }: { handle: string }): ReactElement {
  const [uses, setUses] = useState<SecretUseRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    secretsApi
      .uses(handle)
      .then((u) => live && setUses(u))
      .catch((err: unknown) => live && setError(refusal(err)));
    return () => {
      live = false;
    };
  }, [handle]);
  return (
    <Section label="Used">
      {error ? (
        <p className="field-error">{error}</p>
      ) : uses === null ? (
        <Empty inline>Reading…</Empty>
      ) : uses.length === 0 ? (
        <Empty inline>Not used yet.</Empty>
      ) : (
        <ul className="secret-lines">
          {uses.map((u) => (
            <li key={u.id} className="secret-line">
              <span className="secret-line-main">
                <span>{u.frameOrigin ?? u.origin ?? u.app ?? u.tool}</span>
                <span className="secret-line-meta">
                  {SURFACE_WORDS[u.surface]} · {u.fields.join(", ")}
                  {u.decidedBy ? ` · ${u.decidedBy}` : ""}
                </span>
              </span>
              <span className="secret-line-meta">{agoWords(u.at)}</span>
              <Pill tone={OUTCOME_TONE(u.outcome)}>{u.outcome}</Pill>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/**
 * A value shown on purpose: a step-up first (the passphrase, or the label
 * typed when there is none), then the value for 30 s with Copy. The value
 * is written into the page directly and wiped, never kept in state.
 */
function Reveal({ secret, status }: { secret: SecretSummary; status: VaultStatus | null }): ReactElement {
  const fields = secret.fields.filter((f) => f !== "billing");
  const [field, setField] = useState<SecretFieldName>(fields.find((f) => MAIN.has(f)) ?? fields[0] ?? "password");
  const [until, setUntil] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const out = useRef<HTMLElement>(null);
  const value = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const byPassphrase = status?.slots.includes("passphrase") ?? false;

  const clear = (): void => {
    value.current = "";
    if (out.current) out.current.textContent = "";
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setUntil(null);
    setCopied(false);
  };
  useEffect(() => clear, []);

  const reveal = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    const proof = takeSecretValues(e.currentTarget).proof ?? "";
    if (!proof) {
      setError(byPassphrase ? "Type the vault's passphrase." : `Type ${secret.label} to confirm.`);
      return;
    }
    setError(null);
    try {
      const shown = await secretsApi.reveal(secret.handle, field, byPassphrase ? { passphrase: proof } : { label: proof });
      clear();
      // Billing is not offered here, so the answer is a string; an address would be read as its lines.
      value.current = typeof shown === "string" ? shown : Object.values(shown).filter(Boolean).join("\n");
      setUntil(Date.now() + REVEAL_MS);
      timer.current = setTimeout(clear, REVEAL_MS);
    } catch (err) {
      setError(refusal(err));
    }
  };
  // Written once the box is drawn, so the value goes from the answer to the page and nowhere else.
  useEffect(() => {
    if (until && out.current) out.current.textContent = value.current;
  }, [until]);

  return (
    <Section label="Reveal">
      {until ? (
        <div className="secret-revealed">
          <code ref={out} className="secret-revealed-value" aria-label={`${FIELD_LABEL[field]}, shown for 30 seconds`} />
          <div className="secret-revealed-acts">
            <span className="secret-line-meta">Hidden again in 30 s</span>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() =>
                void navigator.clipboard.writeText(value.current).then(() => {
                  setCopied(true);
                })
              }
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <button type="button" className="btn btn--sm btn--ghost" onClick={clear}>
              Hide
            </button>
          </div>
        </div>
      ) : (
        <form className="secret-fields" onSubmit={(e) => void reveal(e)} autoComplete="off">
          {fields.length > 1 && <Chips small options={fields.map((f) => [f, FIELD_LABEL[f]] as const)} selected={field} onChoose={setField} label="Field to reveal" />}
          <div className="secret-reveal-row">
            {byPassphrase ? (
              <SecretField label="Vault passphrase" name="proof" />
            ) : (
              <SecretField label={`Type “${secret.label}” to confirm`} name="proof" plain />
            )}
            <button type="submit" className="btn">
              Reveal
            </button>
          </div>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
    </Section>
  );
}
