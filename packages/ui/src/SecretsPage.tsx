import { timeWords } from "@kos/shared";
import { useCallback, useEffect, useState, type FormEvent, type ReactElement } from "react";

import type { SecretSummary, VaultStatus } from "@kos/shared";
import { Card, clearSecretValues, EmptyState, hintWords, NavIcon, Pill, readSecretValues, SecretField, Tag, takeSecretValues } from "@kos/kit";

import { useHashParam } from "./hashparams.js";
import { PageHead } from "./PageHead.js";

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
        taken={(secrets ?? []).filter((x) => x.source === "vault").map((x) => x.label)}
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
            <span className="secret-row-used">{s.lastUsedAt ? `Used ${timeWords(s.lastUsedAt)}` : "Never used"}</span>
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
  const mac = status.devices?.[0]?.name;
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
          {waits && mac ? `KOS for Mac on ${mac} opens the vault when it connects; until then, or if it cannot, type the passphrase. ` : waits ? "The vault has a passphrase, so it stays locked after KOS starts. " : ""}
          Until it is unlocked, KOS cannot fill anything from it, and its values are not masked word for word in what KOS writes; only their shapes (a card number, a key) are.
        </p>
        {waits && status.atLogin && <p className="secret-warn">{status.atLogin}</p>}
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

/** How the vault opens, in words: each way in, the passphrase named as the way back. */
export function unlocksWords(status: VaultStatus): string {
  const macs = (status.devices ?? []).map((d) => d.name);
  if (macs.length) return `At login, by KOS for Mac on ${macs.join(" or ")}; the passphrase is the way back in`;
  return status.slots.includes("passphrase") ? "When you type the passphrase" : "On its own when KOS starts";
}

/** The vault itself: how it opens, what was masked since boot, its passphrase, unlock at login, rotating its key and wiping it. */
function VaultCard({ status, onChanged }: { status: VaultStatus; onChanged: (s: VaultStatus) => void }): ReactElement {
  const hasPassphrase = status.slots.includes("passphrase");
  const devices = status.devices ?? [];
  const [open, setOpen] = useState<"passphrase" | "wipe" | "login-on" | "login-off" | null>(null);
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
  const toggle = (which: "passphrase" | "wipe" | "login-on" | "login-off"): void => {
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
          <dt>Unlocks</dt>
          <dd title={devices.length ? "KOS for Mac keeps a key in this Mac's Secure Enclave that opens the vault while you are logged in" : hasPassphrase ? "The vault has a passphrase and no key file" : "A key file on this computer, outside the workspace, opens it"}>
            {unlocksWords(status)}
          </dd>
        </div>
        <div>
          <dt>Hidden from what KOS writes</dt>
          <dd title="Each time a secret's value turned up in something KOS wrote, it was blanked out before anyone saw it or it was kept">
            {status.scrubbed === 0 ? "No secret has turned up since KOS started" : `${status.scrubbed} ${status.scrubbed === 1 ? "time" : "times"} since KOS started`}
          </dd>
        </div>
      </dl>
      <div className="secret-vault-acts">
        <button type="button" className="btn" disabled={busy} title="Re-encrypt every secret with a fresh key; nothing else changes" onClick={() => void run(secretsApi.rotate, "Key changed.")}>
          Change the key
        </button>
        <button type="button" className="btn" aria-expanded={open === "passphrase"} title={hasPassphrase ? undefined : "Lock the vault behind a passphrase you type after each start"} onClick={() => toggle("passphrase")}>
          {hasPassphrase ? "Change passphrase" : "Add passphrase"}
        </button>
        {note && <span className="hint">{note}</span>}
      </div>
      <LoginUnlock status={status} busy={busy} open={open === "login-on" || open === "login-off"} onAdd={() => toggle("login-on")} onToggleOff={() => toggle("login-off")} />
      {open === "login-on" && (
        <form
          className="secret-wipe"
          aria-label="Unlock at login"
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            const { passphrase } = takeSecretValues(e.currentTarget);
            if (!passphrase) return setError("Type the passphrase.");
            void run(() => secretsApi.addDevice(passphrase), "KOS for Mac now opens the vault at login.");
          }}
        >
          <p className="hint">From now on the vault opens whenever KOS for Mac on this computer connects while you are logged in, with nothing typed. Type the passphrase to say so.</p>
          <div className="secret-gate-row">
            <SecretField label="Passphrase" name="passphrase" autoFocus />
          </div>
          <div className="secret-vault-acts secret-confirm-acts">
            <button type="button" className="btn" onClick={() => setOpen(null)}>
              Cancel
            </button>
            <button type="submit" className="btn btn--primary" disabled={busy}>
              Turn on
            </button>
          </div>
        </form>
      )}
      {open === "login-off" && devices[0] && (
        <form
          className="secret-wipe"
          aria-label="Turn off unlock at login"
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            const { passphrase } = takeSecretValues(e.currentTarget);
            if (!passphrase) return setError("Type the passphrase.");
            void run(() => secretsApi.removeDevice(devices[0]!.id, passphrase), "KOS for Mac no longer opens the vault; it waits for the passphrase after each start.");
          }}
        >
          <p className="hint">After this the vault waits for the passphrase after each start. The vault gets a new key, so this Mac opens no copy of it either.</p>
          <div className="secret-gate-row">
            <SecretField label="Passphrase" name="passphrase" autoFocus />
          </div>
          <div className="secret-vault-acts secret-confirm-acts">
            <button type="button" className="btn" onClick={() => setOpen(null)}>
              Cancel
            </button>
            <button type="submit" className="btn btn--primary" disabled={busy}>
              Turn off
            </button>
          </div>
        </form>
      )}
      {/* Apart from the routine two, and said for what it is. */}
      <div className="secret-vault-danger">
        <span className="hint">Erase the vault and every secret in it, for good.</span>
        <button type="button" className="btn btn--danger btn--sm" aria-expanded={open === "wipe"} onClick={() => toggle("wipe")}>
          Wipe vault
        </button>
      </div>
      {open === "passphrase" && (
        <form key={`pass-${hasPassphrase}`} className="secret-wipe" aria-label="The vault's passphrase" autoComplete="off" onSubmit={(e) => {
            e.preventDefault();
            changePassphrase(e.currentTarget, false);
          }}>
          <p className="hint">
            {devices.length
              ? "Change it; it stays the way back in. To go back to the key file, turn off unlock at login first."
              : hasPassphrase
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
            {hasPassphrase && !devices.length && (
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
          {/* A confirm, as every confirm: Cancel, then what it confirms, last at the right. */}
          <div className="secret-vault-acts secret-confirm-acts">
            <button type="button" className="btn" onClick={() => setOpen(null)}>
              Cancel
            </button>
            <button type="submit" className="btn btn--danger" disabled={typed !== "wipe" || busy}>
              Wipe everything
            </button>
          </div>
        </form>
      )}
      {error && <p className="field-error" role="alert">{error}</p>}
    </Card>
  );
}

/**
 * Unlock at login with KOS for Mac: on, the Mac on this computer opens the
 * vault whenever it connects, from a key in its Secure Enclave; off, the
 * passphrase after each start. Offered beside a passphrase only, which stays
 * the way back in.
 */
function LoginUnlock({ status, busy, open, onAdd, onToggleOff }: { status: VaultStatus; busy: boolean; open: boolean; onAdd: () => void; onToggleOff: () => void }): ReactElement | null {
  const device = status.devices?.[0];
  if (device) {
    return (
      <div className="secret-vault-acts">
        <span className="hint">Unlock at login with KOS for Mac on {device.name}: on.</span>
        <button type="button" className="btn btn--sm" aria-expanded={open} onClick={onToggleOff}>
          Turn off
        </button>
      </div>
    );
  }
  if (!status.mac) return null;
  const why = !status.slots.includes("passphrase") ? "Set a passphrase first: it is the way back in if the Mac cannot open the vault." : "reason" in status.mac ? status.mac.reason : undefined;
  return (
    <div className="secret-vault-acts">
      <button type="button" className="btn" disabled={busy || why !== undefined} aria-expanded={open} title="KOS for Mac keeps a key in this Mac's Secure Enclave and opens the vault whenever you are logged in, with no passphrase to type" onClick={onAdd}>
        Unlock at login with KOS for Mac
      </button>
      <span className="hint">{why ?? `On ${"name" in status.mac ? status.mac.name : "this Mac"}; the passphrase stays the way back in.`}</span>
    </div>
  );
}
