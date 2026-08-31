import { useEffect, useState, type ReactElement } from "react";

import { api, type SiteInfo } from "./api.js";
import { hrefFor } from "./routes.js";

/**
 * The web apps KOS has built.
 *
 * These open in a new tab rather than in a frame. A site is agent-written
 * markup, and the point of serving it on its own port is that it does not get
 * to share this page's origin; embedding it here would hand back some of what
 * that separation is for.
 */

export interface SitesPageProps {
  onOpenFiles: (path: string) => void;
}

function when(ms: number): string {
  if (!ms) return "";
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function SitesPage({ onOpenFiles }: SitesPageProps): ReactElement {
  const [sites, setSites] = useState<SiteInfo[] | null>(null);
  const [base, setBase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .sites()
      .then((r) => {
        if (cancelled) return;
        setSites(r.sites);
        setBase(r.base);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="sites">
      <header className="sites-head">
        <h2>Sites</h2>
        <p className="hint">
          Web apps KOS has built. Each is a folder in the workspace, served on
          its own port so its scripts cannot reach this dashboard or the
          network.
        </p>
      </header>

      {error && (
        <p className="ops-alert ops-alert--err" role="alert">
          {error}
        </p>
      )}

      {sites && sites.length === 0 && (
        <p className="hint">
          Nothing built yet. Ask KOS for something, like “build me a habit
          tracker I can open in a browser”.
        </p>
      )}

      {!base && sites && sites.length > 0 && (
        <p className="ops-alert" role="status">
          Site serving is switched off, so these cannot be opened. Start the
          host without <code>--sites-port 0</code> to serve them.
        </p>
      )}

      {sites && sites.length > 0 && (
        <div className="sites-grid">
          {sites.map((s) => (
            <article key={s.name} className="site-card">
              <h3>{s.name}</h3>
              <p className="hint">
                {s.hasIndex ? when(s.modifiedAt) : "no index.html yet"}
              </p>
              <div className="site-actions">
                {base && s.hasIndex && (
                  <a
                    className="btn btn--primary"
                    href={`${base}/${encodeURIComponent(s.name)}/`}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    Open
                  </a>
                )}
                <a
                  className="btn"
                  href={hrefFor({ name: "files", path: `sites/${s.name}` })}
                  onClick={(e) => {
                    e.preventDefault();
                    onOpenFiles(`sites/${s.name}`);
                  }}
                >
                  Files
                </a>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
