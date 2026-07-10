import { useMemo, useState } from "react";

export interface Column<T> {
  key: string;
  header: string;
  width?: string;
  render: (row: T) => React.ReactNode;
  /** Optional string used for search filtering */
  searchText?: (row: T) => string;
}

/**
 * Full-page searchable table. Rows open the inspector when clicked.
 */
export function ListPage<T>(props: {
  title: string;
  subtitle?: string;
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string | number;
  onRowClick: (row: T) => void;
  empty?: string;
  filters?: React.ReactNode;
  toolbar?: React.ReactNode;
}): React.ReactElement {
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return props.rows;
    return props.rows.filter((row) => {
      const bits = props.columns.map((c) => {
        if (c.searchText) return c.searchText(row);
        const node = c.render(row);
        return typeof node === "string" || typeof node === "number"
          ? String(node)
          : "";
      });
      return bits.join(" ").toLowerCase().includes(needle);
    });
  }, [props.rows, props.columns, q]);

  return (
    <section className="list-page">
      <header className="list-head">
        <div>
          <h1 className="list-title">{props.title}</h1>
          {props.subtitle && <p className="ops-muted">{props.subtitle}</p>}
        </div>
        <div className="list-head-tools">
          {props.toolbar}
          <input
            className="list-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search…"
            aria-label={`Search ${props.title}`}
          />
        </div>
      </header>
      {props.filters && <div className="list-filters">{props.filters}</div>}
      <div className="list-meta ops-muted">
        {filtered.length} of {props.rows.length}
      </div>
      <div className="ops-table-wrap list-table">
        <table className="ops-table">
          <thead>
            <tr>
              {props.columns.map((c) => (
                <th key={c.key} style={c.width ? { width: c.width } : undefined}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={props.columns.length} className="ops-muted">
                  {props.empty ?? "No rows"}
                </td>
              </tr>
            )}
            {filtered.map((row) => (
              <tr
                key={props.rowKey(row)}
                className="ops-row-click"
                onClick={() => props.onRowClick(row)}
              >
                {props.columns.map((c) => (
                  <td key={c.key}>{c.render(row)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
