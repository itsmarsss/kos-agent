import { useCallback, useEffect, useState, type FormEvent, type ReactElement } from "react";

import { Card, Empty, NavIcon, Pill, SecretField, Tag, takeSecretValues } from "@kos/kit";

import { PageHead } from "./PageHead.js";
import { agoWords } from "./schedulewords.js";
import { SecretSheet, type SecretSheetMode } from "./SecretSheet.js";
import type { SecretSummary, VaultStatus } from "@kos/shared";

import { KINDS, refusal, secretsApi, whereWords } from "./secrets.js";

/**
 * Secrets: the passwords, cards and keys KOS uses without seeing them.
 *
 * The vault first (set it up, unlock it), then the list, a row a secret
 * by its label, kind, hint, where it may be used and when it was last;
 * a row opens its sheet. Values go in and never come back out, except by
 * a reveal with a step-up.
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
      setSecrets(s.state === "ready" ? await secretsApi.list() : null);
      setError(null);
    } catch (err) {
      setError(refusal(err));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

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
        {...(secrets ? { count: secrets.length } : {})}
        subtitle="Passwords, cards and keys KOS fills in for you without ever seeing them."
        {...(ready
          ? {
              actions: (
                <button type="button" className="btn btn--primary" onClick={() => setSheet({ kind: "add" })}>
                  Add secret
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
      {status?.state === "absent" && <InitCard onDone={setStatus} after={refresh} />}
      {status?.state === "locked" && <UnlockCard onDone={setStatus} after={refresh} />}
      {ready && secrets && (
        <>
          <SecretList secrets={secrets} onOpen={(secret) => setSheet({ kind: "edit", secret })} onAdd={() => setSheet({ kind: "add" })} />
          <VaultCard status={status} onChanged={(s) => {
            setStatus(s);
            void refresh();
          }} />
        </>
      )}
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

function SecretList({ secrets, onOpen, onAdd }: { secrets: SecretSummary[]; onOpen: (s: SecretSummary) => void; onAdd: () => void }): ReactElement {
  if (secrets.length === 0) {
    return (
      <Empty title="No secrets yet">
        Add a login, a card or a key, and say where it may be used.
        <span className="secret-empty-act">
          <button type="button" className="btn btn--primary" onClick={onAdd}>
            Add secret
          </button>
        </span>
      </Empty>
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
                {s.hint && <span className="kos-mono">{s.hint}</span>}
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

function InitCard({ onDone, after }: { onDone: (s: VaultStatus) => void; after: () => Promise<void> }): ReactElement {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    const { passphrase } = takeSecretValues(e.currentTarget);
    setBusy(true);
    try {
      onDone(await secretsApi.init(passphrase));
      await after();
    } catch (err) {
      setError(refusal(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Set up the vault" className="secret-gate">
      <form className="secret-gate-form" onSubmit={(e) => void submit(e)} autoComplete="off">
        <p className="hint">Secrets are kept encrypted on this computer, outside the workspace. A key file opens the vault when KOS starts; a passphrase, if you set one, also keeps it locked after each start until you type it. Leave it blank to rely on the key file alone.</p>
        <div className="secret-gate-row">
          <SecretField label="Passphrase (optional)" name="passphrase" />
          <button type="submit" className="btn btn--primary" disabled={busy}>
            Create vault
          </button>
        </div>
        {error && <p className="field-error" role="alert">{error}</p>}
      </form>
    </Card>
  );
}

function UnlockCard({ onDone, after }: { onDone: (s: VaultStatus) => void; after: () => Promise<void> }): ReactElement {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    const { passphrase } = takeSecretValues(e.currentTarget);
    if (!passphrase) {
      setError("Type the passphrase.");
      return;
    }
    setBusy(true);
    try {
      onDone(await secretsApi.unlock(passphrase));
      setError(null);
      await after();
    } catch (err) {
      setError(refusal(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Vault" pill={<Pill tone="warn">Locked</Pill>} className="secret-gate">
      <form className="secret-gate-form" onSubmit={(e) => void submit(e)} autoComplete="off">
        <p className="hint">The vault has a passphrase, so it stays locked after KOS starts. Until it is unlocked, KOS cannot fill anything from it.</p>
        <div className="secret-gate-row">
          <SecretField label="Passphrase" name="passphrase" autoFocus />
          <button type="submit" className="btn btn--primary" disabled={busy}>
            Unlock
          </button>
        </div>
        {error && <p className="field-error" role="alert">{error}</p>}
      </form>
    </Card>
  );
}

/** The vault itself: how it opens, what was masked since boot, rotating its key and wiping it. */
function VaultCard({ status, onChanged }: { status: VaultStatus; onChanged: (s: VaultStatus) => void }): ReactElement {
  const [wiping, setWiping] = useState(false);
  const [typed, setTyped] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = (op: () => Promise<VaultStatus>, done: string): void => {
    setError(null);
    void op()
      .then((s) => {
        setNote(done);
        onChanged(s);
      })
      .catch((err: unknown) => setError(refusal(err)));
  };
  return (
    <Card title="Vault" className="secret-vault">
      <dl className="secret-facts">
        <div>
          <dt>Opens with</dt>
          <dd>{status.slots.map((s) => (s === "keyfile" ? "Key file" : "Passphrase")).join(" and ")}</dd>
        </div>
        <div>
          <dt>Masked since start</dt>
          <dd title="Times a secret's value was caught in KOS's output and masked before it was kept or shown">
            {status.scrubbed} {status.scrubbed === 1 ? "time" : "times"}
          </dd>
        </div>
      </dl>
      <div className="secret-vault-acts">
        <button type="button" className="btn" onClick={() => run(secretsApi.rotate, "Key rotated.")}>
          Rotate key
        </button>
        <button type="button" className="btn btn--danger" aria-expanded={wiping} onClick={() => setWiping((v) => !v)}>
          Wipe vault
        </button>
        {note && <span className="hint">{note}</span>}
      </div>
      {wiping && (
        <div className="secret-wipe" role="group" aria-label="Wipe vault">
          <p className="hint">Every secret goes, for good: the vault and its key are overwritten. Type wipe to confirm.</p>
          <div className="secret-gate-row">
            <input className="kos-input kos-mono" aria-label="Type wipe to confirm" value={typed} autoComplete="off" spellCheck={false} onChange={(e) => setTyped(e.target.value)} />
            <button
              type="button"
              className="btn btn--danger"
              disabled={typed !== "wipe"}
              onClick={() => {
                setWiping(false);
                setTyped("");
                run(secretsApi.wipe, "Vault wiped.");
              }}
            >
              Wipe everything
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => setWiping(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <p className="field-error" role="alert">{error}</p>}
    </Card>
  );
}
