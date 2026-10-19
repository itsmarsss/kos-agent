import { Fragment, useMemo, useState } from "react";

import { PageHead } from "./PageHead.js";

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
  /**
   * Break the rows into labelled runs, in the order they already appear.
   * A flat list of the last hundred things, newest first forever, gives no
   * sense of when anything happened; "Today" and "Yesterday" do most of that
   * work for free.
   */
  groupBy?: (row: T) => string;
  /** Group headers fold their rows away, and remember it, per page title. */
  collapsible?: boolean;
  /**
   * Honour the declared column widths instead of sizing to content.
   *
   * Under the browser's automatic layout a cell that refuses to wrap grows the
   * table until it overflows, which pushed the columns after it off the side
   * of the page entirely. Fixed layout is right when the widths are known and
   * the content is what should give.
   */
  fixedLayout?: boolean;
}): React.ReactElement {
  const [q, setQ] = useState("");
  const foldKey = `kos.list.${props.title}.folded`;
  const [folded, setFolded] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(foldKey);
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  });
  const toggleFold = (group: string): void => {
    setFolded((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      try {
        localStorage.setItem(foldKey, JSON.stringify([...next]));
      } catch {
        // Remembered for this visit only.
      }
      return next;
    });
  };

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
      <PageHead
        title={props.title}
        {...(props.subtitle ? { subtitle: props.subtitle } : {})}
        search={
          <input
            className="list-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search…"
            aria-label={`Search ${props.title}`}
          />
        }
        {...(props.toolbar ? { actions: props.toolbar } : {})}
      />
      {props.filters && <div className="list-filters">{props.filters}</div>}
      <div className="list-meta ops-muted">
        {filtered.length} of {props.rows.length}
      </div>
      <div className="ops-table-wrap list-table">
        <table
          className={`ops-table ${props.fixedLayout ? "ops-table--fixed" : ""}`}
        >
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
            {filtered.map((row, i) => {
              const group = props.groupBy?.(row);
              const previous =
                i > 0 ? props.groupBy?.(filtered[i - 1]!) : undefined;
              return (
                <Fragment key={props.rowKey(row)}>
                  {group && group !== previous ? (
                    <tr className={`list-group ${props.collapsible ? "is-foldable" : ""} ${group && folded.has(group) ? "is-folded" : ""}`}>
                      <th colSpan={props.columns.length} scope="colgroup">
                        {props.collapsible ? (
                          <button type="button" className="list-group-fold" aria-expanded={!folded.has(group)} onClick={() => toggleFold(group)}>
                            <span className="list-group-caret" aria-hidden="true">{folded.has(group) ? "▸" : "▾"}</span>
                            {group}
                          </button>
                        ) : (
                          group
                        )}
                      </th>
                    </tr>
                  ) : null}
                  {!(props.collapsible && group && folded.has(group)) && (
                    <tr
                      className="ops-row-click"
                      onClick={() => props.onRowClick(row)}
                    >
                      {props.columns.map((c) => (
                        <td key={c.key}>{c.render(row)}</td>
                      ))}
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
