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
export function PageHistory({ record, onRolledBack }: { record: PageSummary; onRolledBack: () => Promise<unknown> }): ReactElement | null {
  const [versions, setVersions] = useState<PageVersion[]>([]);
  const [chosen, setChosen] = useState<string>("");
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
        setChosen(String(list.at(-2)?.version ?? ""));
      })
      .catch((err: unknown) => !stale && failed(err));
    return () => {
      stale = true;
    };
  }, [record.id, record.updatedAt]);

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
    .map((v) => ({ value: String(v.version), label: `Version ${v.version}, ${relativeWords(Math.round(v.at / 1000))}` }));
  return (
    <div className="page-history">
      <span className="hint">Version {current} of {versions.length}</span>
      <Select value={chosen} options={options} onChange={setChosen} label="Version to go back to" />
      <ConfirmButton
        label="Roll back"
        text={`Show version ${chosen} again? The page as it is now stays in its history.`}
        className="btn btn--sm"
        disabled={!chosen}
        onConfirm={() =>
          void api
            .pageRollback(record.id, Number(chosen))
            .then(onRolledBack)
            .then(() => setError(undefined), failed)
        }
      />
      {alert}
    </div>
  );
}
