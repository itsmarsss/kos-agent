import { useEffect, useRef, useState, type FormEvent, type ReactElement, type ReactNode } from "react";

import { Chips, Countdown, EmptyState, Field, hintWords, SheetFoot, OriginList, PAYMENT_FRAMES, Pill, SecretField, GroupHead, Switch, Tag, clearSecretValues, readSecretValues, takeSecretValues, type Tone } from "@kos/kit";

import { fieldErrorOf } from "./api.js";
import { Drawer } from "./Drawer.js";
import { ConfirmButton } from "./kit.js";

import { checkName, SECRET_KINDS, type SecretBilling, type SecretFieldName, type SecretKind, type SecretSummary, type SecretUse, type SecretUseRow, type SecretValues, type VaultStatus, timeWords } from "@kos/shared";

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

/**
 * `takeSeed` hands over what to start a new secret with, once: the opener
 * gives it up as it is taken. `asked` is what KOS asked the owner to add
 * (secrets.request): its kind and label, never a value.
 */
export type SecretSheetMode = { kind: "add"; takeSeed?: () => SecretSeed | null; asked?: { kind: SecretKind; label?: string } } | { kind: "edit"; secret: SecretSummary };

const FORM_ID = "secret-form";
/** How long a revealed value stays on screen. */
export const REVEAL_MS = 30_000;

/** When KOS asks before using it, as the owner would choose: the chip, and what it means. */
const ASK_CHOICES: Record<SecretDraft["policy"]["ask"], readonly [string, string]> = {
  always: [ASK_WORDS.always, "KOS asks you before each use."],
  turn: ["Once per request", "One yes covers the rest of what you asked KOS to do."],
  site: ["Once per site", "One yes on a site is remembered for that site."],
};

/** The field a new secret of each kind cannot be made without. */
const REQUIRED: Record<SecretKind, SecretFieldName> = { login: "password", card: "number", apikey: "token", note: "text" };

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
  taken = [],
  onClose,
  onSaved,
  onDeleted,
}: {
  open: boolean;
  mode: SecretSheetMode;
  status?: VaultStatus | null;
  /** Chats a secret can be limited to. */
  conversations?: readonly { id: string; title: string }[];
  /** The labels other secrets have, so a new one is told it is taken before it is sent. */
  taken?: readonly string[];
  onClose: () => void;
  onSaved: (secret: SecretSummary | { handle: string }) => void;
  onDeleted?: (handle: string) => void;
}): ReactElement {
  const editing = mode.kind === "edit" ? mode.secret : null;
  const title = editing ? editing.label : "New secret";
  const sub = editing ? KINDS[editing.kind].label : "KOS can use it without seeing it";
  const readOnly = editing?.source === "env";
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  return (
    <Drawer
      open={open}
      title={title}
      subtitle={sub}
      onClose={onClose}
      footer={
        readOnly ? undefined : (
          <SheetFoot
            onCancel={onClose}
            danger={
              editing &&
              onDeleted && (
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
              )
            }
            note={
              deleteError && (
                <span className="field-error" role="alert">
                  {deleteError}
                </span>
              )
            }
            primary={
              <button type="submit" form={FORM_ID} className="btn btn--primary" disabled={blocked}>
                {editing ? "Save" : "Create"}
              </button>
            }
          />
        )
      }
    >
      <SheetBody key={editing?.handle ?? "new"} mode={mode} status={status ?? null} conversations={conversations} taken={taken.filter((l) => l !== editing?.label)} onBlocked={setBlocked} onSaved={onSaved} />
    </Drawer>
  );
}

function SheetBody({
  mode,
  status,
  conversations,
  taken,
  onBlocked,
  onSaved,
}: {
  mode: SecretSheetMode;
  status: VaultStatus | null;
  conversations: readonly { id: string; title: string }[];
  taken: readonly string[];
  onBlocked: (blocked: boolean) => void;
  onSaved: (secret: SecretSummary | { handle: string }) => void;
}): ReactElement {
  const editing = mode.kind === "edit" ? mode.secret : null;
  // Taken once, on the first render, and let go once the fields have it.
  const seedRef = useRef<SecretSeed | null | undefined>(undefined);
  if (seedRef.current === undefined) seedRef.current = (mode.kind === "add" ? mode.takeSeed?.() : null) ?? null;
  const seed = seedRef.current;
  useEffect(() => {
    seedRef.current = null;
  }, []);
  const readOnly = editing?.source === "env";
  const [summary, setSummary] = useState<SecretSummary | null>(editing);
  const asked = mode.kind === "add" ? mode.asked : undefined;
  const [label, setLabel] = useState(editing?.label ?? asked?.label ?? "");
  const [kind, setKind] = useState<SecretKind>(editing?.kind ?? seed?.kind ?? asked?.kind ?? "login");
  const [use, setUse] = useState<SecretUse>(editing?.use ?? emptyUse());
  const [policy, setPolicy] = useState<SecretDraft["policy"]>(editing ? { ask: editing.policy.ask, unattended: editing.policy.unattended, chats: editing.policy.chats } : defaultPolicy());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** Said only once Create is pressed: a label or a value left empty. */
  const [tried, setTried] = useState(false);
  const [labelRefused, setLabelRefused] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  // The one name check the server makes, as the owner types; empty is said only after a try.
  const labelCheck = checkName(label, { noun: "secret", taken });
  const labelError = labelRefused ?? (labelCheck && (labelCheck.problem !== "empty" || tried) ? labelCheck.message : null);
  const blocked = labelCheck !== null && labelCheck.problem !== "empty";
  useEffect(() => onBlocked(blocked), [blocked, onBlocked]);

  const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (saving || readOnly) return;
    setTried(true);
    const form = e.currentTarget;
    const lacking = !editing && !readSecretValues(form)[REQUIRED[kind]];
    setMissing(lacking);
    if (labelCheck || lacking) return;
    // Read from the fields, never into state, and cleared once saved: a refused save leaves them typed for the retry,
    // where clearing them first made an edit's retry save "unchanged" and report the old password rotated.
    const values = valuesOf(readSecretValues(form));
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
        clearSecretValues(form);
        onSaved(saved);
      } else {
        const created = await secretsApi.create({ label: label.trim(), kind, values, use: sent, policy: { ...policy, grants: [] } });
        clearSecretValues(form);
        onSaved(created);
      }
    } catch (err) {
      const onLabel = fieldErrorOf(err, "label");
      if (onLabel) setLabelRefused(onLabel);
      else setError(refusal(err));
    } finally {
      setSaving(false);
    }
  };

  const set = (field: SecretFieldName): boolean => editing?.fields.includes(field) ?? false;
  const hintFor = (field: SecretFieldName): string | undefined => (editing && field === editing.fields.find((f) => MAIN.has(f)) ? hintWords(editing.hint) : undefined);
  const seedFor = (field: SecretFieldName): string | undefined => {
    const now = seedRef.current;
    return now && now.kind === kind && now.field === field ? now.value : undefined;
  };
  const field = (name: SecretFieldName, extra: { plain?: boolean; multiline?: boolean; required?: boolean; inputMode?: "numeric"; placeholder?: string } = {}): ReactElement => {
    const s = seedFor(name);
    const h = hintFor(name);
    const error = missing && name === REQUIRED[kind] ? `Type the ${FIELD_LABEL[name].toLowerCase()}.` : null;
    return <SecretField key={`${kind}-${name}`} label={FIELD_LABEL[name]} name={name} set={set(name)} disabled={readOnly} error={error} {...extra} {...(h ? { hint: h } : {})} {...(s ? { seed: s } : {})} />;
  };

  return (
    <div className="secret-sheet">
      <form id={FORM_ID} className="secret-form" onSubmit={(e) => void submit(e)} autoComplete="off" noValidate>
        {readOnly && <p className="set-note">From the environment, as {editing!.handle}. Change it where KOS is started; it cannot be edited here.</p>}
        <Field label="Label" required hint="The name you will know it by." error={labelError}>
          <input
            className="kos-input"
            value={label}
            disabled={readOnly}
            placeholder="Such as GitHub"
            autoComplete="off"
            aria-invalid={labelError !== null}
            onChange={(e) => {
              setLabelRefused(null);
              setLabel(e.target.value);
            }}
          />
        </Field>
        {!editing && (
          <Field label="Kind" group>
            <Chips options={SECRET_KINDS.map((k) => [k, KINDS[k].label] as const)} selected={kind} onChoose={setKind} label="Kind" />
          </Field>
        )}

        <SheetGroup title="Values">
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
        </SheetGroup>

        {kind === "card" && (
          <SheetGroup title={FIELD_LABEL.billing}>
            <div className="secret-billing">
              {BILLING_PARTS.map((p) => (
                <SecretField key={p.key} label={p.label} name={`billing.${p.key}`} plain disabled={readOnly} {...(set("billing") ? { placeholder: "Unchanged" } : {})} />
              ))}
            </div>
            {set("billing") && <p className="hint secret-section-hint">Leave it blank to keep the address. Parts you type replace those parts; the rest are kept.</p>}
          </SheetGroup>
        )}

        <SheetGroup title="Where it may be used">
          <div className="secret-fields">
            {kind === "apikey" ? (
              <>
                <OriginList label="API hosts" mode="host" value={use.http.hosts} disabled={readOnly} hint="KOS sends the key only to these, such as api.openai.com." onChange={(hosts) => setUse({ ...use, http: { ...use.http, hosts } })} />
                {use.http.hosts.length === 0 && !readOnly && (
                  <p className="secret-warn" role="note">
                    With no host, KOS can't send this key anywhere. Add the API's host above.
                  </p>
                )}
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
                <OriginList label="Sites" value={use.web.origins} disabled={readOnly} hint="The sites KOS may fill it in on, such as https://github.com. https://*.example.com covers every part of a site." onChange={(origins) => setUse({ ...use, web: { ...use.web, origins } })} />
                <OriginList label="Payment boxes" value={use.web.frames} disabled={readOnly} {...(kind === "card" ? { presets: PAYMENT_FRAMES } : {})} hint="A box from another company inside those sites, such as a card form from a payment provider." onChange={(frames) => setUse({ ...use, web: { ...use.web, frames } })} />
              </>
            )}
            <OriginList label="Mac apps" mode="bundle" value={use.apps} disabled={readOnly} hint="Apps on a paired Mac it may be typed into, by the app's ID, such as com.apple.Safari." onChange={(apps) => setUse({ ...use, apps })} />
          </div>
        </SheetGroup>

        <SheetGroup title="When KOS asks">
          <div className="secret-fields">
            <Field label="Ask" group>
              <Chips small options={askOptions(kind, policy.ask).map((a) => [a, ASK_CHOICES[a][0], ASK_CHOICES[a][1]] as const)} selected={policy.ask} onChoose={(ask) => !readOnly && setPolicy({ ...policy, ask })} label="Ask" />
            </Field>
            <p className="hint secret-section-hint">{ASK_CHOICES[policy.ask][1]}</p>
            <SwitchLine label="Use it when you're not there" hint="For schedules and other work KOS does on its own." on={policy.unattended} disabled={readOnly} onChange={(unattended) => setPolicy({ ...policy, unattended })} />
            {policy.unattended && <p className="secret-warn" role="note">A run with nobody watching can use this secret and nobody is there to say no. Turn it on only for one a schedule needs.</p>}
            <SwitchLine label="Only in some chats" on={policy.chats !== null} disabled={readOnly} onChange={(on) => setPolicy({ ...policy, chats: on ? [] : null })} />
            {policy.chats !== null && <ChatPicks chosen={policy.chats} conversations={conversations} disabled={readOnly} onChange={(chats) => setPolicy({ ...policy, chats })} />}
          </div>
        </SheetGroup>
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

/** The asks a kind is offered: an API key goes to hosts, not sites, so Once per site is only for the rest, unless it is already set. */
function askOptions(kind: SecretKind, current: SecretDraft["policy"]["ask"]): SecretDraft["policy"]["ask"][] {
  return kind === "apikey" && current !== "site" ? ["always", "turn"] : ["always", "turn", "site"];
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
  if (conversations.length === 0 && others.length === 0) return <EmptyState variant="inline">No chats to choose from yet; until one is ticked, no chat can use it.</EmptyState>;
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
    <SheetGroup title="Remembered sites">
      {secret.policy.grants.length === 0 ? (
        <EmptyState variant="inline">None yet. A yes you ask KOS to remember shows here.</EmptyState>
      ) : (
        <ul className="secret-lines">
          {secret.policy.grants.map((g) => (
            <li key={g.origin} className="secret-line">
              <span className="secret-line-main">{g.origin}</span>
              <span className="secret-line-meta">{timeWords(g.at)}</span>
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
    </SheetGroup>
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
    <SheetGroup title="Used">
      {error ? (
        <p className="field-error">{error}</p>
      ) : uses === null ? (
        <EmptyState variant="inline">Reading…</EmptyState>
      ) : uses.length === 0 ? (
        <EmptyState variant="inline">Not used yet.</EmptyState>
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
              <span className="secret-line-meta">{timeWords(u.at)}</span>
              <Pill tone={OUTCOME_TONE(u.outcome)}>{u.outcome}</Pill>
            </li>
          ))}
        </ul>
      )}
    </SheetGroup>
  );
}

/**
 * A value shown on purpose: a step-up first (the passphrase, or the label
 * typed when there is none), then the value for 30 s. The value is written
 * into the page directly and wiped, never kept in state.
 *
 * There is no Copy. A page writes the clipboard as plain text alone, with
 * no way to mark it concealed or transient, so a clipboard history app
 * would keep the value for good and another device's Universal Clipboard
 * would get it; nor can a page clear it once it loses focus. The owner's
 * password manager is the place to copy a secret from.
 */
function Reveal({ secret, status }: { secret: SecretSummary; status: VaultStatus | null }): ReactElement {
  const fields = secret.fields.filter((f): f is Exclude<SecretFieldName, "billing"> => f !== "billing");
  const [field, setField] = useState<Exclude<SecretFieldName, "billing">>(fields.find((f) => MAIN.has(f)) ?? fields[0] ?? "password");
  const [until, setUntil] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const out = useRef<HTMLElement>(null);
  const value = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef(true);
  const byPassphrase = status?.slots.includes("passphrase") ?? false;

  const clear = (): void => {
    value.current = "";
    if (out.current) out.current.textContent = "";
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (!live.current) return;
    setUntil(null);
  };
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      clear();
    };
  }, []);

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
      // The sheet closed while it was asked for: the answer is dropped, not drawn.
      if (!live.current) return;
      clear();
      value.current = shown;
      setUntil(Date.now() + REVEAL_MS);
      timer.current = setTimeout(clear, REVEAL_MS);
    } catch (err) {
      if (live.current) setError(refusal(err));
    }
  };
  // Written once the box is drawn, so the value goes from the answer to the page and nowhere else.
  useEffect(() => {
    if (until && out.current) out.current.textContent = value.current;
  }, [until]);

  return (
    <SheetGroup title="Reveal">
      {until ? (
        <div className="secret-revealed">
          <code ref={out} className="secret-revealed-value" aria-label={`${FIELD_LABEL[field]}, shown for 30 seconds`} />
          <div className="secret-revealed-acts">
            <span className="secret-line-meta">
              <Countdown until={until} lead="Hidden in" />
            </span>
            <button type="button" className="btn btn--sm" onClick={clear}>
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
    </SheetGroup>
  );
}

/** A titled part of the sheet: its head as every group's (GroupHead), then what it holds. */
function SheetGroup({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <section className="section sheet-group">
      <GroupHead as="h3" title={title} />
      {children}
    </section>
  );
}
