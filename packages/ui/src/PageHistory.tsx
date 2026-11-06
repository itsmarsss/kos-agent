import { Empty, Pill } from "@kos/kit";
import { relativeWords } from "@kos/shared";
import { useEffect, useState, type ReactElement } from "react";

import { api, type PageSummary, type PageVersion } from "./api.js";
import { ConfirmButton } from "./kit.js";
import { Select } from "./Select.js";

/**
 * A page's kept versions, and a way back to one. Every write the agent makes
 * is kept, so a page it broke is one choice away from how it was; the
 * rollback is itself kept, so it can be undone too.
 */

/** The versions, newest last, fetched again whenever the page changes. */
function useVersions(record: PageSummary): { versions: PageVersion[]; error?: string; rollBack: (version: number, then: () => Promise<unknown>) => void } {
  const [versions, setVersions] = useState<PageVersion[]>([]);
  const [error, setError] = useState<string>();
  const failed = (err: unknown): void => setError(err instanceof Error ? err.message : String(err));

  useEffect(() => {
    let stale = false;
    void api
      .pageHistory(record.id)
      .then((list) => {
        if (stale) return;
        setError(undefined);
        setVersions(list);
      })
      .catch((err: unknown) => !stale && failed(err));
    return () => {
      stale = true;
    };
  }, [record.id, record.updatedAt]);

  const rollBack = (version: number, then: () => Promise<unknown>): void =>
    void api
      .pageRollback(record.id, version)
      .then(then)
      .then(() => setError(undefined), failed);
  return { versions, ...(error ? { error } : {}), rollBack };
}

const ago = (at: number): string => relativeWords(Math.round(at / 1000));

/** The versions as a choice and a button, in a row above the page. */
export function PageHistory({ record, onRolledBack }: { record: PageSummary; onRolledBack: () => Promise<unknown> }): ReactElement | null {
  const { versions, error, rollBack } = useVersions(record);
  const [picked, setChosen] = useState<string>("");
  // The one before the current, until the owner picks another.
  const chosen = picked || String(versions.at(-2)?.version ?? "");

  const alert = error ? (
    <p className="ops-alert ops-alert--err" role="alert">
      Page history: {error}
    </p>
  ) : null;
  // One version is the page as it is: nothing to go back to.
  if (versions.length < 2) return alert;
  const current = versions.at(-1)!.version;
  const options = versions
    .slice(0, -1)
    .reverse()
    .map((v) => ({ value: String(v.version), label: `Version ${v.version}, ${ago(v.at)}` }));
  return (
    <div className="page-history">
      <span className="hint">Version {current} of {versions.length}</span>
      <Select value={chosen} options={options} onChange={setChosen} label="Version to go back to" />
      <ConfirmButton
        label="Roll back"
        text={`Show version ${chosen} again? The page as it is now stays in its history.`}
        className="btn btn--sm"
        disabled={!chosen}
        onConfirm={() => rollBack(Number(chosen), onRolledBack)}
      />
      {alert}
    </div>
  );
}

/** The versions as a list, newest first, each older one with a preview and a way back: for a drawer. */
export function VersionList({
  record,
  onRolledBack,
  onPreview,
  previewing,
}: {
  record: PageSummary;
  onRolledBack: () => Promise<unknown>;
  /** Show this version in place of the current one, to look at; absent for a page that cannot be previewed. */
  onPreview?: (version: PageVersion) => void;
  /** The version being looked at now, if any. */
  previewing?: number;
}): ReactElement {
  const { versions, error, rollBack } = useVersions(record);
  const current = versions.at(-1)?.version;
  return (
    <div className="versions">
      {error && (
        <p className="ops-alert ops-alert--err" role="alert">
          Page history: {error}
        </p>
      )}
      {versions.length < 2 && !error && <Empty inline>One version so far. Each change is kept here, with a way back.</Empty>}
      {versions.length > 0 && (
        <ol className="versions-list" aria-label="Versions">
          {[...versions].reverse().map((v) => (
            <li key={v.version} className={`versions-row${v.version === previewing ? " is-on" : ""}`}>
              <span className="line-text">
                <strong>Version {v.version}</strong>
                <span>
                  {ago(v.at)}
                  {v.title !== record.title ? `, titled "${v.title}"` : ""}
                </span>
              </span>
              {v.version === current ? (
                <Pill tone="ok">Current</Pill>
              ) : (
                <span className="versions-acts">
                  {onPreview && v.kind === "html" && (
                    <button type="button" className="btn btn--ghost btn--sm" aria-pressed={v.version === previewing} onClick={() => onPreview(v)}>
                      Preview
                    </button>
                  )}
                  <ConfirmButton
                    label="Restore"
                    text={`Restore version ${v.version}? The artifact as it is now stays in its history.`}
                    className="btn btn--sm"
                    onConfirm={() => rollBack(v.version, onRolledBack)}
                  />
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
