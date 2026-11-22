import { useCallback, useEffect, useState, type FormEvent, type ReactElement } from "react";

import type { SecretSummary, VaultStatus } from "@kos/shared";
import { Card, clearSecretValues, EmptyState, hintWords, NavIcon, Pill, readSecretValues, SecretField, Tag, takeSecretValues } from "@kos/kit";

import { useHashParam } from "./hashparams.js";
import { PageHead } from "./PageHead.js";
import { agoWords } from "./schedulewords.js";
import { SecretSheet, type SecretSheetMode } from "./SecretSheet.js";
import { KINDS, refusal, secretsApi, whereWords } from "./secrets.js";

/**
 * Secrets: the passwords, cards and keys KOS uses without seeing them.
 *
 * The vault first (set it up, unlock it), then the list, a row a secret
 * by its label, kind, hint, where it may be used and when it was last;
 * a row opens its sheet. Values go in and never come back out, except by
 * a reveal with a step-up. While the vault is locked the list holds only
 * the env secrets, read-only.
 */
export function SecretsPage({ conversations = [] }: { conversations?: readonly { id: string; title: string }[] }): ReactElement {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [secrets, setSecrets] = useState<SecretSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SecretSheetMode | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const s = await secretsApi.status();
      setStatus(s);
      setSecrets(await secretsApi.list());
      setError(null);
    } catch (err) {
      setError(refusal(err));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  // A secret the address names (a search hit): its sheet, once the list has it.
  const [asked, clearAsked] = useHashParam("open");
  useEffect(() => {
    const secret = asked ? secrets?.find((s) => s.handle === asked) : undefined;
    if (!secret) return;
    clearAsked();
    setSheet({ kind: "edit", secret });
  }, [asked, secrets, clearAsked]);
  const changed = (s: VaultStatus): void => {
    setStatus(s);
    void refresh();
  };

  const close = (): void => setSheet(null);
  const saved = (): void => {
    close();
    void refresh();
  };

  const ready = status?.state === "ready";
  return (
    <div className="secrets">
      <PageHead
        title="Secrets"
        {...(secrets && ready ? { count: secrets.length } : {})}
        subtitle="Passwords, cards and keys KOS fills in for you without ever seeing them."
        {...(ready
          ? {
              actions: (
                <button type="button" className="btn btn--primary" onClick={() => setSheet({ kind: "add" })}>
                  New secret
                </button>
              ),
            }
          : {})}
      />
      {error && (
        <p className="ops-alert ops-alert--err" role="alert">
          {error}
        </p>
      )}
      {status?.problem && (
        <p className="secret-warn" role="alert">
          {status.problem}
        </p>
      )}
      {status?.state === "absent" && <InitCard onDone={changed} />}
      {status?.state === "locked" && <UnlockCard status={status} onDone={changed} />}
      {secrets && (ready || secrets.length > 0) && <SecretList secrets={secrets} onOpen={(secret) => setSheet({ kind: "edit", secret })} />}
      {ready && <VaultCard status={status} onChanged={changed} />}
      <SecretSheet
        open={sheet !== null}
        mode={sheet ?? { kind: "add" }}
        status={status}
        conversations={conversations}
        onClose={close}
        onSaved={saved}
        onDeleted={saved}
      />
    </div>
  );
}

function SecretList({ secrets, onOpen }: { secrets: SecretSummary[]; onOpen: (s: SecretSummary) => void }): ReactElement {
  if (secrets.length === 0) {
    return (
      // The head's New secret is the one way in: a second primary here said the same thing twice.
      <EmptyState title="No secrets yet">Add a login, a card or a key with New secret, and say where it may be used.</EmptyState>
    );
  }
  return (
    <ul className="secret-list" aria-label="Secrets">
      {secrets.map((s) => (
        <li key={s.handle}>
          <button type="button" className="secret-row" onClick={() => onOpen(s)}>
            <span className="secret-row-mark" aria-hidden="true">
              <NavIcon name="secrets" />
            </span>
            <span className="secret-row-main">
              <span className="secret-row-title">
                <strong>{s.label}</strong>
                <Tag>{KINDS[s.kind].label}</Tag>
                {s.source === "env" && <Tag title="Set in the environment; read-only here">From env</Tag>}
              </span>
              <span className="secret-row-detail">
                {s.hint && <span className="kos-mono">{hintWords(s.hint)}</span>}
                <span>{whereWords(s.use)}</span>
              </span>
            </span>
            <span className="secret-row-used">{s.lastUsedAt ? `Used ${agoWords(s.lastUsedAt)}` : "Never used"}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Whether a new passphrase was typed the same twice, read without taking
 * it from the form; on a mismatch the second is cleared to type again.
 */
function typedTwice(form: HTMLFormElement, first: string, again: string): boolean {
  const a = form.elements.namedItem(first) as HTMLInputElement | null;
  const b = form.elements.namedItem(again) as HTMLInputElement | null;
  if (!a || !b || a.value === b.value) return true;
  b.value = "";
  b.focus();
  return false;
}

const MISMATCH = "The two passphrases do not match. Type it again.";

function InitCard({ onDone }: { onDone: (s: VaultStatus) => void }): ReactElement {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (!typedTwice(e.currentTarget, "passphrase", "again")) return setError(MISMATCH);
    const { passphrase } = takeSecretValues(e.currentTarget);
    setError(null);
    setBusy(true);
    try {
      onDone(await secretsApi.init(passphrase));
    } catch (err) {
      setError(refusal(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Set up the vault" className="secret-gate">
      <form className="secret-gate-form" onSubmit={(e) => void submit(e)} autoComplete="off">
        <p className="hint">
          Secrets are kept encrypted on this computer, outside the workspace. Without a passphrase, a key file beside the vault opens it when KOS starts. With one, there is no key file: the vault stays locked after each start until you type it, and a forgotten passphrase loses every secret.
        </p>
        <div className="secret-gate-row">
          <SecretField label="Passphrase (optional)" name="passphrase" newPassword />
          <SecretField label="Type it again" name="again" newPassword />
          <button type="submit" className="btn btn--primary" disabled={busy}>
            Create vault
          </button>
        </div>
        {error && <p className="field-error" role="alert">{error}</p>}
      </form>
    </Card>
  );
}

function UnlockCard({ status, onDone }: { status: VaultStatus; onDone: (s: VaultStatus) => void }): ReactElement {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const waits = status.slots.includes("passphrase") && !status.problem;
  const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    // Read, and cleared only once it has worked: a failed try (KOS restarting, say) keeps what was typed.
    const form = e.currentTarget;
    const { passphrase } = readSecretValues(form);
    if (!passphrase) {
      setError("Type the passphrase.");
      return;
    }
    setBusy(true);
    try {
      const opened = await secretsApi.unlock(passphrase);
      clearSecretValues(form);
      onDone(opened);
      setError(null);
    } catch (err) {
      setError(refusal(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Vault" pill={<Pill tone="warn">Locked</Pill>} className="secret-gate">
      <form className="secret-gate-form" onSubmit={(e) => void submit(e)} autoComplete="off">
        <p className="hint">
          {waits ? "The vault has a passphrase, so it stays locked after KOS starts. " : ""}
          Until it is unlocked, KOS cannot fill anything from it, and its values are not masked word for word in what KOS writes; only their shapes (a card number, a key) are.
        </p>
        {waits && (
          <div className="secret-gate-row">
            <SecretField label="Passphrase" name="passphrase" autoFocus />
            <button type="submit" className="btn btn--primary" disabled={busy}>
              Unlock
            </button>
          </div>
        )}
        {error && <p className="field-error" role="alert">{error}</p>}
      </form>
    </Card>
  );
}

/** The vault itself: how it opens, what was masked since boot, its passphrase, rotating its key and wiping it. */
function VaultCard({ status, onChanged }: { status: VaultStatus; onChanged: (s: VaultStatus) => void }): ReactElement {
  const hasPassphrase = status.slots.includes("passphrase");
  const [open, setOpen] = useState<"passphrase" | "wipe" | null>(null);
  const [typed, setTyped] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (op: () => Promise<VaultStatus>, done: string): Promise<void> => {
    setError(null);
    setNote(null);
    setBusy(true);
    try {
      const s = await op();
      setNote(done);
      setOpen(null);
      setTyped("");
      onChanged(s);
    } catch (err) {
      setError(refusal(err));
    } finally {
      setBusy(false);
    }
  };
  const toggle = (which: "passphrase" | "wipe"): void => {
    setOpen((o) => (o === which ? null : which));
    setError(null);
    setTyped("");
  };

  const changePassphrase = (form: HTMLFormElement, remove: boolean): void => {
    if (!remove && !typedTwice(form, "next", "again")) return setError(MISMATCH);
    const { current, next } = takeSecretValues(form);
    if (hasPassphrase && !current) return setError("Type the current passphrase.");
    if (!remove && !next) return setError("Type the new passphrase.");
    void run(
      () => secretsApi.passphrase({ ...(current ? { current } : {}), ...(remove ? {} : { passphrase: next }) }),
      remove ? "Passphrase removed; the key file opens it again." : hasPassphrase ? "Passphrase changed." : "Passphrase set; the key file is gone.",
    );
  };

  return (
    <Card title="Vault" pill={<Pill tone="ok">Open</Pill>} className="secret-vault">
      <dl className="secret-facts">
        <div>
          <dt>Opens with</dt>
          <dd>{hasPassphrase ? "Passphrase" : "Key file"}</dd>
        </div>
        <div>
          <dt>Masked since start</dt>
          <dd title="Times a secret's value was caught in KOS's output and masked before it was kept or shown">
            {status.scrubbed} {status.scrubbed === 1 ? "time" : "times"}
          </dd>
        </div>
      </dl>
      <div className="secret-vault-acts">
        <button type="button" className="btn" disabled={busy} onClick={() => void run(secretsApi.rotate, "Key rotated.")}>
          Rotate key
        </button>
        <button type="button" className="btn" aria-expanded={open === "passphrase"} onClick={() => toggle("passphrase")}>
          {hasPassphrase ? "Change passphrase" : "Add passphrase"}
        </button>
        <button type="button" className="btn btn--danger" aria-expanded={open === "wipe"} onClick={() => toggle("wipe")}>
          Wipe vault
        </button>
        {note && <span className="hint">{note}</span>}
      </div>
      {open === "passphrase" && (
        <form key={`pass-${hasPassphrase}`} className="secret-wipe" aria-label="The vault's passphrase" autoComplete="off" onSubmit={(e) => {
            e.preventDefault();
            changePassphrase(e.currentTarget, false);
          }}>
          <p className="hint">
            {hasPassphrase
              ? "Change it, or remove it to go back to the key file. Either needs the current one."
              : "With a passphrase the key file is erased: the vault is locked after each start until you type it, and a forgotten passphrase loses every secret."}
          </p>
          <div className="secret-gate-row">
            {hasPassphrase && <SecretField label="Current passphrase" name="current" />}
            <SecretField label={hasPassphrase ? "New passphrase" : "Passphrase"} name="next" newPassword />
            <SecretField label="Type it again" name="again" newPassword />
          </div>
          <div className="secret-vault-acts">
            <button type="submit" className="btn btn--primary" disabled={busy}>
              {hasPassphrase ? "Change passphrase" : "Set passphrase"}
            </button>
            {hasPassphrase && (
              <button type="button" className="btn" disabled={busy} onClick={(e) => changePassphrase(e.currentTarget.form!, true)}>
                Remove passphrase
              </button>
            )}
            <button type="button" className="btn btn--ghost" onClick={() => setOpen(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {open === "wipe" && (
        <form
          className="secret-wipe"
          aria-label="Wipe vault"
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            const { passphrase } = takeSecretValues(e.currentTarget);
            if (hasPassphrase && !passphrase) return setError("Type the passphrase.");
            void run(() => secretsApi.wipe(passphrase), "Vault wiped.");
          }}
        >
          <p className="hint">Every secret goes, for good: the vault and its key are overwritten. Type wipe to confirm{hasPassphrase ? ", and the passphrase" : ""}.</p>
          <div className="secret-gate-row">
            <input className="kos-input kos-mono" aria-label="Type wipe to confirm" placeholder="wipe" value={typed} autoComplete="off" spellCheck={false} onChange={(e) => setTyped(e.target.value)} />
            {hasPassphrase && <SecretField label="Passphrase" name="passphrase" />}
          </div>
          <div className="secret-vault-acts">
            <button type="submit" className="btn btn--danger" disabled={typed !== "wipe" || busy}>
              Wipe everything
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => setOpen(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {error && <p className="field-error" role="alert">{error}</p>}
    </Card>
  );
}
