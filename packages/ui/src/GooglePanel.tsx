import { useCallback, useEffect, useState, type ReactElement } from "react";
import { Field, Pill, Switch, Tag } from "@kos/kit";

import { api, type GoogleInfo } from "./api.js";
import { ConfirmButton, FieldRow } from "./kit.js";

/**
 * The owner's Google account: Calendar, Gmail, Drive and Docs.
 *
 * Three steps, each shown once the one before is done: the OAuth client's
 * JSON from Google Cloud goes into the vault, the owner signs in with Google
 * in their browser, and the switches say how far KOS may go. Read-only
 * until changes are allowed, and sending mail is a switch of its own. While
 * a sign-in waits in the browser the page looks again every few seconds.
 */

const POLL_MS = 2000;
const SCOPE_PREFIX = "https://www.googleapis.com/auth/";

function scopeWord(scope: string): string {
  return scope.startsWith(SCOPE_PREFIX) ? scope.slice(SCOPE_PREFIX.length) : scope;
}

function serverWords(info: GoogleInfo): { tone: "ok" | "warn" | "muted"; word: string; hint: string } {
  if (!info.settings.on) return { tone: "muted", word: "Off", hint: "KOS does not use the account while this is off. The sign-in is kept." };
  if (info.signingIn) return { tone: "warn", word: "Signing in", hint: "Waiting for you to finish in the browser." };
  if (info.server?.error) return { tone: "warn", word: "Not running", hint: info.server.error };
  if (info.server?.connected) return { tone: "ok", word: "Connected", hint: `${info.server.tools} tools, ${info.settings.changes ? "reading and changing" : "reading only"}.` };
  return { tone: "muted", word: "Starting", hint: "The Google server is starting." };
}

export function GooglePanel(): ReactElement {
  const [info, setInfo] = useState<GoogleInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [json, setJson] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [signInUrl, setSignInUrl] = useState<string | null>(null);

  const load = useCallback(() => {
    void api.google().then(setInfo, (err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    if (!info?.signingIn) return;
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [info?.signingIn, load]);

  const run = (work: Promise<GoogleInfo>, after?: (next: GoogleInfo) => void): void => {
    setBusy(true);
    setError(null);
    void work
      .then((next) => {
        setInfo(next);
        after?.(next);
      }, (err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  const importClient = (): void =>
    run(api.importGoogleClient(json), () => {
      setJson("");
      setReplacing(false);
    });

  /** Opened at the press, so the browser lets it; pointed at Google once the server gives the address. */
  const signIn = (): void => {
    const tab = window.open("", "_blank");
    setBusy(true);
    setError(null);
    setSignInUrl(null);
    void api
      .googleSignIn()
      .then(
        (next) => {
          if (tab) tab.location.href = next.url;
          setSignInUrl(next.url);
          setInfo(next);
        },
        (err: unknown) => {
          tab?.close();
          setError(err instanceof Error ? err.message : String(err));
          load();
        },
      )
      .finally(() => setBusy(false));
  };

  const readFile = (file: File | undefined): void => {
    if (file) void file.text().then(setJson);
  };

  if (!info) return <p className="hint">{error ?? "Loading…"}</p>;
  const state = serverWords(info);
  const showImport = !info.client || replacing;

  return (
    <>
      {error && (
        <p className="ops-alert ops-alert--err" role="alert">
          {error}
        </p>
      )}
      {info.vault && !info.client && <p className="hint">The OAuth client is kept in the vault, and {info.vault}.</p>}
      {showImport ? (
        <Field
          label="OAuth client"
          hint={`The JSON Google Cloud downloads for a Desktop app client (Clients > Download JSON). It is kept in the vault, never in a file; delete the download once it is here. A Web application client needs ${info.redirectUri} as a redirect URI.`}
        >
          <div className="set-install-json">
            <textarea className="ops-textarea" rows={4} placeholder='{"installed": {"client_id": "….apps.googleusercontent.com", "client_secret": "…"}}' value={json} onChange={(e) => setJson(e.target.value)} />
            <div className="set-inline">
              <input type="file" accept="application/json,.json" aria-label="Choose the client JSON file" onChange={(e) => readFile(e.target.files?.[0])} />
              <button type="button" className="btn btn--sm btn--primary" disabled={busy || !json.trim()} onClick={importClient}>
                Import
              </button>
              {replacing && (
                <button type="button" className="btn btn--sm" onClick={() => setReplacing(false)}>
                  Cancel
                </button>
              )}
            </div>
          </div>
        </Field>
      ) : (
        <div className="set-rows">
          <FieldRow label="OAuth client" hint={<code>{info.client!.id}</code>}>
            <button type="button" className="link" onClick={() => setReplacing(true)}>
              Replace
            </button>
          </FieldRow>
        </div>
      )}

      {info.client && (
        <div className="set-rows">
          <FieldRow
            label={info.account ? info.account.email : "Google account"}
            badge={info.account ? <Pill tone={state.tone}>{state.word}</Pill> : undefined}
            hint={info.account ? state.hint : "Not signed in. Sign in opens Google in your browser; KOS never sees your password."}
            meta={
              info.account && (
                <span className="set-origin">
                  {info.account.scopes.map((s) => (
                    <Tag key={s} mono>
                      {scopeWord(s)}
                    </Tag>
                  ))}
                </span>
              )
            }
          >
            <button type="button" className="btn btn--sm" disabled={busy || info.signingIn} onClick={signIn}>
              {info.account ? "Sign in again" : "Sign in with Google"}
            </button>
            {info.account && (
              <ConfirmButton
                label="Disconnect"
                text="Revokes KOS's access at Google and deletes the sign-in from this computer. The client stays in the vault."
                disabled={busy}
                onConfirm={() => run(api.disconnectGoogle())}
              />
            )}
          </FieldRow>
        </div>
      )}
      {info.signingIn && (
        <p className="hint">
          Finish signing in in the browser.{" "}
          {signInUrl && (
            <a href={signInUrl} target="_blank" rel="noreferrer">
              Open the Google sign-in
            </a>
          )}
        </p>
      )}
      {info.error && (
        <p className="ops-alert ops-alert--err" role="alert">
          {info.error}
        </p>
      )}
      {info.account && info.missing.length > 0 && !info.signingIn && (
        <p className="hint">Sign in again to grant what this mode needs: {info.missing.map(scopeWord).join(", ")}.</p>
      )}

      {info.account && (
        <div className="set-rows">
          <FieldRow label="Use Google" hint="Calendar, Gmail, Drive and Docs. Reading runs without asking; anything a guest starts never reaches it.">
            <Switch label="Use Google" on={info.settings.on} disabled={busy} onChange={(on) => run(api.setGoogle({ on }))} />
          </FieldRow>
          <FieldRow label="Allow changes" hint="Creating, editing and deleting events, drafts, labels, Drive files and Docs. Each one asks you first. A delete, or anything another person would see (a share, an invitation), is never let through by a quick repeat, a schedule or Auto.">
            <Switch label="Allow changes" on={info.settings.changes} disabled={busy} onChange={(changes) => run(api.setGoogle({ changes }))} />
          </FieldRow>
          <FieldRow label="Allow sending mail" hint="Each email asks you, every time: no saved yes, schedule or Auto covers a send.">
            <Switch label="Allow sending mail" on={info.settings.send} disabled={busy || !info.settings.changes} onChange={(send) => run(api.setGoogle({ send }))} />
          </FieldRow>
        </div>
      )}
    </>
  );
}
