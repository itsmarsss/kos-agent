import { useEffect, useState, type ReactElement } from "react";

import { api, type CatalogMcp, type CatalogMcpListing, type CatalogSkills } from "./api.js";

/**
 * Finding skills and MCP servers without leaving Settings.
 *
 * Skills are listed from a repository folder in Claude Code's shape,
 * Anthropic's collection first; the owner can point at any other. MCP
 * servers come as a short list of the reference ones, ready to add, and a
 * search of the official registry, which says what each needs before it is
 * written to mcp.json. Both install through the same paths the forms above
 * them use, so a thing found here is a thing the owner could have typed.
 */

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function SkillBrowser({ onInstalled }: { onInstalled: () => void }): ReactElement {
  const [source, setSource] = useState("");
  const [typed, setTyped] = useState("");
  const [data, setData] = useState<CatalogSkills | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = (from: string): void => {
    setLoading(true);
    setError(null);
    void api
      .catalogSkills(from || undefined)
      .then((r) => {
        setData(r);
        setSource(from);
      })
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => load(""), []);

  const install = (name: string, from: string): void => {
    setBusy(name);
    setError(null);
    void api
      .installSkill(from, name)
      .then(() => {
        onInstalled();
        setData((cur) => (cur ? { ...cur, skills: cur.skills.map((s) => (s.name === name ? { ...s, installed: true } : s)) } : cur));
      })
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setBusy(null));
  };

  return (
    <div className="set-group ext-browser">
      <h3>Find a skill</h3>
      <p className="hint">
        A folder of skills in a repository, each one a SKILL.md. Installed is off until you switch it on above.
      </p>
      <div className="ext-sources">
        {(data?.sources ?? []).map((s) => (
          <button
            key={s.repo}
            type="button"
            className={`ext-source${source === "" || source === `${s.repo}/${s.path}` ? " is-on" : ""}`}
            title={s.blurb}
            onClick={() => load("")}
          >
            {s.label}
          </button>
        ))}
        <form
          className="ext-source-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed.trim()) load(typed.trim());
          }}
        >
          <input
            className="kos-input"
            placeholder="or owner/repo/path"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
          <button type="submit" className="btn btn--sm" disabled={loading || !typed.trim()}>
            Browse
          </button>
        </form>
      </div>
      {error && <p className="ops-alert ops-alert--err">{error}</p>}
      {loading && <p className="hint">Reading the repository…</p>}
      {data && !loading && data.skills.length === 0 && <p className="hint">No skills found there.</p>}
      {data && !loading && data.skills.length > 0 && (
        <ul className="ext-list">
          {data.skills.map((s) => (
            <li key={s.source} className="ext-item">
              <div className="ext-item-text">
                <span className="ext-item-name">{s.name}</span>
                <span className="ext-item-blurb">{s.description || "No description."}</span>
                <a className="ext-item-link" href={s.source} target="_blank" rel="noreferrer">
                  {s.repo}
                </a>
              </div>
              <button
                type="button"
                className="btn btn--sm"
                disabled={s.installed || busy !== null}
                onClick={() => install(s.name, s.source)}
              >
                {s.installed ? "Installed" : busy === s.name ? "Installing…" : "Install"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** What a listing asks for, as a small form before it is added. */
function Asks({
  listing,
  choice,
  values,
  onChange,
}: {
  listing: CatalogMcpListing;
  choice: { package?: number; remote?: number };
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
}): ReactElement | null {
  const vars = choice.remote !== undefined ? listing.remotes[choice.remote]?.headers : listing.packages[choice.package ?? 0]?.env;
  if (!vars || vars.length === 0) return null;
  return (
    <div className="ext-asks">
      {vars.map((v) => (
        <label key={v.name} className="ext-ask">
          <span className="ext-ask-name">
            {v.name}
            {v.required && <span className="ext-ask-req"> required</span>}
          </span>
          <input
            className="kos-input"
            type={v.secret ? "password" : "text"}
            placeholder={v.description || (choice.remote !== undefined ? "header value" : "value")}
            value={values[v.name] ?? ""}
            onChange={(e) => onChange(v.name, e.target.value)}
          />
        </label>
      ))}
    </div>
  );
}

function Listing({
  listing,
  onAdded,
}: {
  listing: CatalogMcpListing;
  onAdded: () => void;
}): ReactElement {
  // The first package, else the first remote: what the registry lists first
  // is what the project documents first.
  const [choice, setChoice] = useState<{ package?: number; remote?: number }>(
    listing.packages.length > 0 ? { package: 0 } : { remote: 0 },
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(listing.installed);

  const options = [
    ...listing.packages.map((p, i) => ({ key: `p${i}`, label: `${p.registry}: ${p.identifier}`, choice: { package: i } })),
    ...listing.remotes.map((r, i) => ({ key: `r${i}`, label: `remote: ${r.url}`, choice: { remote: i } })),
  ];
  const chosenKey = choice.remote !== undefined ? `r${choice.remote}` : `p${choice.package ?? 0}`;
  const missing = (choice.remote !== undefined ? listing.remotes[choice.remote]?.headers : listing.packages[choice.package ?? 0]?.env)
    ?.filter((v) => v.required && !values[v.name]?.trim()) ?? [];

  const add = (): void => {
    setBusy(true);
    setError(null);
    void api
      .addMcpFromCatalog({ listing, choice, values })
      .then(() => {
        setAdded(true);
        setOpen(false);
        onAdded();
      })
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setBusy(false));
  };

  return (
    <li className="ext-item">
      <div className="ext-item-text">
        <span className="ext-item-name">
          {listing.title}
          {listing.version && <span className="ext-item-version"> {listing.version}</span>}
        </span>
        <span className="ext-item-blurb">{listing.description || "No description."}</span>
        <span className="ext-item-meta">
          <code>{listing.suggestedName}</code>
          {listing.repository && (
            <a className="ext-item-link" href={listing.repository} target="_blank" rel="noreferrer">
              source
            </a>
          )}
        </span>
        {open && (
          <div className="ext-add">
            {options.length > 1 && (
              <select
                className="kos-input"
                aria-label="How to run it"
                value={chosenKey}
                onChange={(e) => {
                  const picked = options.find((o) => o.key === e.target.value);
                  if (picked) setChoice(picked.choice);
                }}
              >
                {options.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
            )}
            <Asks listing={listing} choice={choice} values={values} onChange={(k, v) => setValues((cur) => ({ ...cur, [k]: v }))} />
            {error && <p className="ops-alert ops-alert--err">{error}</p>}
            <div className="ext-add-actions">
              <button type="button" className="btn btn--sm btn--primary" disabled={busy || missing.length > 0} onClick={add}>
                {busy ? "Adding…" : "Add to mcp.json"}
              </button>
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => setOpen(false)}>
                Cancel
              </button>
              {missing.length > 0 && <span className="hint">needs {missing.map((m) => m.name).join(", ")}</span>}
            </div>
          </div>
        )}
      </div>
      {!open && (
        <button type="button" className="btn btn--sm" disabled={added} onClick={() => setOpen(true)}>
          {added ? "Added" : "Add"}
        </button>
      )}
    </li>
  );
}

export function McpBrowser({ onAdded }: { onAdded: () => void }): ReactElement {
  const [q, setQ] = useState("");
  const [data, setData] = useState<CatalogMcp | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const search = (query: string): void => {
    setLoading(true);
    setError(null);
    void api
      .catalogMcp(query)
      .then(setData)
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => search(""), []);

  const addPick = (name: string): void => {
    setBusy(name);
    setError(null);
    void api
      .addMcpPick(name)
      .then(() => {
        onAdded();
        setData((cur) => (cur ? { ...cur, picks: cur.picks.map((p) => (p.name === name ? { ...p, installed: true } : p)) } : cur));
      })
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setBusy(null));
  };

  return (
    <div className="set-group ext-browser">
      <h3>Find a server</h3>
      <p className="hint">
        The reference servers, ready to add, and the official registry behind a search. A stdio server needs its
        runtime on this machine: node for npx, uv for uvx, docker for images.
      </p>
      {data && (
        <ul className="ext-picks">
          {data.picks.map((p) => (
            <li key={p.name} className="ext-pick">
              <div className="ext-item-text">
                <span className="ext-item-name">
                  {p.name}
                  <span className="ext-item-needs"> {p.needs}</span>
                </span>
                <span className="ext-item-blurb">{p.blurb}</span>
                <code className="ext-item-cmd">{p.command}</code>
              </div>
              <button
                type="button"
                className="btn btn--sm"
                disabled={p.installed || busy !== null}
                onClick={() => addPick(p.name)}
              >
                {p.installed ? "Added" : busy === p.name ? "Adding…" : "Add"}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="ext-search"
        onSubmit={(e) => {
          e.preventDefault();
          search(q.trim());
        }}
      >
        <input
          className="kos-input"
          placeholder="Search the MCP registry: github, postgres, slack…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button type="submit" className="btn btn--sm" disabled={loading || !q.trim()}>
          {loading ? "Searching…" : "Search"}
        </button>
      </form>
      {error && <p className="ops-alert ops-alert--err">{error}</p>}
      {data && q.trim() && !loading && data.results.length === 0 && <p className="hint">Nothing in the registry for that.</p>}
      {data && data.results.length > 0 && (
        <ul className="ext-list">
          {data.results.map((r) => (
            <Listing key={r.name} listing={r} onAdded={onAdded} />
          ))}
        </ul>
      )}
    </div>
  );
}
