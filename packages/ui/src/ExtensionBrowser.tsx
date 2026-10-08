import { useEffect, useState, type ReactElement, type ReactNode } from "react";

import { api, type CatalogMcp, type CatalogMcpListing, type CatalogSkills, type RepoHit } from "./api.js";

/**
 * Adding skills and MCP servers from Settings.
 *
 * One area per page, with one way of adding shown at a time: browse a
 * collection, search for more, or type a source by hand. Every door used to
 * be open at once (an install form, five chips, a path box, a search box, a
 * filter and twenty descriptions), which was a wall rather than a page.
 *
 * Lists are short by default and rows are compact; a row opens to its full
 * description when clicked. Everything installs through the same paths the
 * old forms used, so a thing found here is a thing the owner could have typed.
 */

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** How many rows a list shows before "Show more". */
const FIRST = 8;

function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: T; label: string }[];
  active: T;
  onChange: (id: T) => void;
}): ReactElement {
  return (
    <div className="ext-tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={t.id === active}
          className={`ext-tab${t.id === active ? " is-on" : ""}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** A row that opens to its full text when its words are clicked. */
function Row({
  name,
  aside,
  blurb,
  meta,
  action,
}: {
  name: string;
  aside?: ReactNode;
  blurb: string;
  meta?: ReactNode;
  action: ReactNode;
}): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <li className={`ext-item${open ? " is-open" : ""}`}>
      <button type="button" className="ext-item-text" onClick={() => setOpen((v) => !v)} title={open ? "Less" : "More"}>
        <span className="ext-item-name">
          {name}
          {aside}
        </span>
        <span className="ext-item-blurb">{blurb || "No description."}</span>
        {open && meta}
      </button>
      <span className="ext-item-action">{action}</span>
    </li>
  );
}

function More({ total, shown, onMore }: { total: number; shown: number; onMore: () => void }): ReactElement | null {
  if (shown >= total) return null;
  return (
    <button type="button" className="ext-more" onClick={onMore}>
      Show {total - shown} more
    </button>
  );
}

type SkillTab = "browse" | "search" | "url";

export function SkillsAdd({ onInstalled }: { onInstalled: () => void }): ReactElement {
  const [tab, setTab] = useState<SkillTab>("browse");
  const [data, setData] = useState<CatalogSkills | null>(null);
  const [source, setSource] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [limit, setLimit] = useState(FIRST);
  const [other, setOther] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<RepoHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [url, setUrl] = useState("");
  const [urlName, setUrlName] = useState("");

  const load = (from: string): void => {
    setLoading(true);
    setError(null);
    setFilter("");
    setLimit(FIRST);
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
        setUrl("");
        setUrlName("");
      })
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setBusy(null));
  };

  const search = (q: string): void => {
    setSearching(true);
    setError(null);
    void api
      .catalogSkillSearch(q)
      .then((r) => setHits(r.repos))
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setSearching(false));
  };

  const needle = filter.trim().toLowerCase();
  const all = (data?.skills ?? []).filter(
    (s) => !needle || s.name.toLowerCase().includes(needle) || s.description.toLowerCase().includes(needle),
  );
  const shown = all.slice(0, limit);
  const current = source || (data ? `${data.source.repo}/${data.source.path}` : "");
  const known = (data?.sources ?? []).some((s) => `${s.repo}/${s.path}` === current);

  return (
    <div className="set-group ext-add-area">
      <div className="ext-add-head">
        <h3>Add a skill</h3>
        <Tabs<SkillTab>
          tabs={[
            { id: "browse", label: "Browse" },
            { id: "search", label: "Search GitHub" },
            { id: "url", label: "From a URL" },
          ]}
          active={tab}
          onChange={setTab}
        />
      </div>
      {error && <p className="ops-alert ops-alert--err">{error}</p>}

      {tab === "browse" && (
        <>
          <div className="ext-sources">
            {(data?.sources ?? []).map((s) => (
              <button
                key={s.repo}
                type="button"
                className={`ext-source${current === `${s.repo}/${s.path}` ? " is-on" : ""}`}
                title={s.blurb}
                onClick={() => load(`${s.repo}/${s.path}`)}
              >
                {s.label}
              </button>
            ))}
            {!known && current && (
              <span className="ext-source is-on" title={current}>
                {current.split("/").slice(0, 2).join("/")}
              </span>
            )}
            <button type="button" className="ext-source ext-source--other" onClick={() => setOther((v) => (v === null ? "" : null))}>
              Other…
            </button>
          </div>
          {other !== null && (
            <form
              className="ext-row-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (other.trim()) {
                  load(other.trim());
                  setOther(null);
                }
              }}
            >
              <input
                className="kos-input"
                placeholder="owner/repo or owner/repo/path"
                value={other}
                autoFocus
                onChange={(e) => setOther(e.target.value)}
              />
              <button type="submit" className="btn btn--sm" disabled={loading || !other.trim()}>
                Browse
              </button>
            </form>
          )}
          {loading && <p className="hint">Reading the repository…</p>}
          {data && !loading && data.skills.length === 0 && <p className="hint">No skills found there.</p>}
          {data && !loading && data.skills.length > 0 && (
            <>
              <div className="ext-filter">
                <input
                  className="kos-input"
                  placeholder={`Filter ${data.skills.length} skills`}
                  value={filter}
                  onChange={(e) => {
                    setFilter(e.target.value);
                    setLimit(FIRST);
                  }}
                />
                <span className="hint">
                  {needle ? `${all.length} of ${data.skills.length}` : `${data.skills.length} in ${data.source.repo}`}
                </span>
              </div>
              <ul className="ext-list">
                {shown.map((s) => (
                  <Row
                    key={s.source}
                    name={s.name}
                    blurb={s.description}
                    meta={
                      <a className="ext-item-link" href={s.source} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                        {s.source.replace("https://github.com/", "")}
                      </a>
                    }
                    action={
                      <button
                        type="button"
                        className="btn btn--sm"
                        disabled={s.installed || busy !== null}
                        onClick={() => install(s.name, s.source)}
                      >
                        {s.installed ? "Installed" : busy === s.name ? "Installing…" : "Install"}
                      </button>
                    }
                  />
                ))}
              </ul>
              <More total={all.length} shown={shown.length} onMore={() => setLimit(all.length)} />
            </>
          )}
        </>
      )}

      {tab === "search" && (
        <>
          <form
            className="ext-row-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (query.trim()) search(query.trim());
            }}
          >
            <input
              className="kos-input"
              placeholder="Collections on GitHub: marketing, science, writing…"
              value={query}
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
            />
            <button type="submit" className="btn btn--sm" disabled={searching || !query.trim()}>
              {searching ? "Searching…" : "Search"}
            </button>
          </form>
          {hits && hits.length === 0 && <p className="hint">GitHub found nothing for that.</p>}
          {hits && hits.length > 0 && (
            <ul className="ext-list">
              {hits.map((h) => (
                <Row
                  key={h.repo}
                  name={h.repo}
                  aside={<span className="ext-item-version"> {h.stars.toLocaleString()} stars</span>}
                  blurb={h.description}
                  meta={
                    <a className="ext-item-link" href={h.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                      on GitHub
                    </a>
                  }
                  action={
                    <button
                      type="button"
                      className="btn btn--sm"
                      disabled={loading}
                      onClick={() => {
                        load(h.repo);
                        setTab("browse");
                      }}
                    >
                      Browse
                    </button>
                  }
                />
              ))}
            </ul>
          )}
          {!hits && <p className="hint">Repositories that look like skill collections, by stars. Browse one to see its skills.</p>}
        </>
      )}

      {tab === "url" && (
        <form
          className="ext-row-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim()) install(urlName.trim() || url.trim(), url.trim());
          }}
        >
          <input
            className="kos-input"
            placeholder="A git URL, a GitHub folder URL, or a folder path"
            value={url}
            autoFocus
            onChange={(e) => setUrl(e.target.value)}
          />
          <input
            className="kos-input ext-name"
            placeholder="Name (optional)"
            value={urlName}
            onChange={(e) => setUrlName(e.target.value)}
          />
          <button type="submit" className="btn btn--sm" disabled={busy !== null || !url.trim()}>
            {busy !== null ? "Installing…" : "Install"}
          </button>
        </form>
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

function Listing({ listing, onAdded }: { listing: CatalogMcpListing; onAdded: () => void }): ReactElement {
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
  const missing =
    (choice.remote !== undefined ? listing.remotes[choice.remote]?.headers : listing.packages[choice.package ?? 0]?.env)?.filter(
      (v) => v.required && !values[v.name]?.trim(),
    ) ?? [];

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
    <li className={`ext-item${open ? " is-open" : ""}`}>
      <button type="button" className="ext-item-text" onClick={() => setOpen((v) => !v)} title={open ? "Less" : "Add"}>
        <span className="ext-item-name">
          {listing.title}
          {listing.version && <span className="ext-item-version"> {listing.version}</span>}
        </span>
        <span className="ext-item-blurb">{listing.description || "No description."}</span>
        {open && (
          <span className="ext-item-meta">
            <code>{listing.suggestedName}</code>
            {listing.repository && (
              <a className="ext-item-link" href={listing.repository} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                source
              </a>
            )}
          </span>
        )}
      </button>
      <span className="ext-item-action">
        {!open && (
          <button type="button" className="btn btn--sm" disabled={added} onClick={() => setOpen(true)}>
            {added ? "Added" : "Add"}
          </button>
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
    </li>
  );
}

type McpTab = "picks" | "search" | "manual";

export function McpAdd({ onAdded }: { onAdded: () => void }): ReactElement {
  const [tab, setTab] = useState<McpTab>("picks");
  const [data, setData] = useState<CatalogMcp | null>(null);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: "", where: "", risk: "risky" as "risky" | "safe" });
  const [json, setJson] = useState("");
  const [paste, setPaste] = useState(false);

  const fetchCatalog = (query: string): void => {
    setLoading(true);
    setError(null);
    void api
      .catalogMcp(query)
      .then(setData)
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => fetchCatalog(""), []);

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

  const addManual = (): void => {
    const name = draft.name.trim();
    const where = draft.where.trim();
    if (!name || !where) return;
    const server: Record<string, unknown> = /^https?:\/\//.test(where)
      ? { url: where }
      : (() => {
          const [command, ...args] = where.split(/\s+/);
          return { command, args };
        })();
    if (draft.risk === "safe") server["risk"] = "safe";
    setBusy("manual");
    setError(null);
    void api
      .addMcpServer({ name, server })
      .then(() => {
        setDraft({ name: "", where: "", risk: "risky" });
        onAdded();
      })
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setBusy(null));
  };

  const addJson = (): void => {
    if (!json.trim()) return;
    setBusy("json");
    setError(null);
    void api
      .addMcpServer({ json: json.trim() })
      .then(() => {
        setJson("");
        onAdded();
      })
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setBusy(null));
  };

  return (
    <div className="set-group ext-add-area">
      <div className="ext-add-head">
        <h3>Add a server</h3>
        <Tabs<McpTab>
          tabs={[
            { id: "picks", label: "Picks" },
            { id: "search", label: "Search the registry" },
            { id: "manual", label: "By hand" },
          ]}
          active={tab}
          onChange={setTab}
        />
      </div>
      {error && <p className="ops-alert ops-alert--err">{error}</p>}

      {tab === "picks" && (
        <>
          <p className="hint">The reference servers, added as their projects document them. A stdio server needs its runtime here: node for npx, uv for uvx.</p>
          {data && (
            <ul className="ext-picks">
              {data.picks.map((p) => (
                <li key={p.name} className="ext-pick" title={p.command}>
                  <span className="ext-pick-text">
                    <span className="ext-item-name">
                      {p.name}
                      <span className="ext-item-needs"> {p.needs}</span>
                    </span>
                    <span className="ext-item-blurb">{p.blurb}</span>
                  </span>
                  <button type="button" className="btn btn--sm" disabled={p.installed || busy !== null} onClick={() => addPick(p.name)}>
                    {p.installed ? "Added" : busy === p.name ? "Adding…" : "Add"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {tab === "search" && (
        <>
          <form
            className="ext-row-form"
            onSubmit={(e) => {
              e.preventDefault();
              fetchCatalog(q.trim());
            }}
          >
            <input
              className="kos-input"
              placeholder="github, postgres, slack…"
              value={q}
              autoFocus
              onChange={(e) => setQ(e.target.value)}
            />
            <button type="submit" className="btn btn--sm" disabled={loading || !q.trim()}>
              {loading ? "Searching…" : "Search"}
            </button>
          </form>
          {data && q.trim() && !loading && data.results.length === 0 && <p className="hint">Nothing in the registry for that.</p>}
          {data && data.results.length > 0 && (
            <ul className="ext-list">
              {data.results.map((r) => (
                <Listing key={r.name} listing={r} onAdded={onAdded} />
              ))}
            </ul>
          )}
          {(!data || data.results.length === 0) && !q.trim() && (
            <p className="hint">The official MCP registry. A result says how it runs and what it needs before anything is written.</p>
          )}
        </>
      )}

      {tab === "manual" && (
        <>
          <form
            className="ext-row-form"
            onSubmit={(e) => {
              e.preventDefault();
              addManual();
            }}
          >
            <input
              className="kos-input ext-name"
              placeholder="Name, e.g. browser"
              value={draft.name}
              autoFocus
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            />
            <input
              className="kos-input"
              placeholder="Command line (npx @playwright/mcp@latest) or URL (https://…/mcp)"
              value={draft.where}
              onChange={(e) => setDraft((d) => ({ ...d, where: e.target.value }))}
            />
            <select
              className="kos-input ext-risk"
              aria-label="Risk floor"
              value={draft.risk}
              onChange={(e) => setDraft((d) => ({ ...d, risk: e.target.value === "safe" ? "safe" : "risky" }))}
            >
              <option value="risky">risky: each call asks</option>
              <option value="safe">safe: every tool runs</option>
            </select>
            <button type="submit" className="btn btn--sm" disabled={busy !== null || !draft.name.trim() || !draft.where.trim()}>
              {busy === "manual" ? "Adding…" : "Add"}
            </button>
          </form>
          <button type="button" className="link ext-toggle-paste" onClick={() => setPaste((v) => !v)}>
            {paste ? "Hide the JSON box" : "Or paste a config from a README"}
          </button>
          {paste && (
            <form
              className="set-install-json"
              onSubmit={(e) => {
                e.preventDefault();
                addJson();
              }}
            >
              <textarea
                className="ops-textarea"
                rows={4}
                placeholder={'{"mcpServers": {"browser": {"command": "npx", "args": ["@playwright/mcp@latest"]}}}'}
                value={json}
                onChange={(e) => setJson(e.target.value)}
              />
              <button type="submit" className="btn btn--sm" disabled={busy !== null || !json.trim()}>
                {busy === "json" ? "Adding…" : "Add from JSON"}
              </button>
            </form>
          )}
        </>
      )}
    </div>
  );
}
