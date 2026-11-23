import { EmptyState, GroupHead, listState, TableHead } from "@kos/kit";
import { Fragment, useMemo, useState } from "react";

import { PageHead } from "./PageHead.js";
import { rowKeys } from "./rowkeys.js";

export interface Column<T> {
  key: string;
  header: string;
  width?: string;
  render: (row: T) => React.ReactNode;
  /** Optional string used for search filtering */
  searchText?: (row: T) => string;
  /**
   * Its place in a row drawn as a card on a phone (`stackOnPhone`): the
   * title, leading the first line; the aside, its actions at that line's
   * end; or, unsaid, one of the facts on the line under them.
   */
  stack?: "title" | "aside";
  /** On a phone's card, its header said before it: a time alone ("in 3h") does not say which. */
  stackLabel?: boolean;
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
  /** What it says with nothing in it at all; a search that finds nothing says so in the kit's words. */
  empty?: string;
  /** The rows have not been read yet: skeleton rows, never the empty line or "0 of 0". */
  loading?: boolean;
  /** What the rows are, for "Search <noun>" and "No <noun> match": "schedules". */
  noun?: string;
  /** Puts the page's own filters back, with the search, from the no-match line's Clear filters. */
  onClearFilters?: () => void;
  filters?: React.ReactNode;
  /** The page's tabs, under its head (`PageTabs`). */
  tabs?: React.ReactNode;
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
  /**
   * Under 640 px, each row as a card of two lines (its title and actions
   * over its other facts, by each column's `stack`) in place of a table
   * wider than the phone, whose last columns sat off screen with nothing
   * to say they were there.
   */
  stackOnPhone?: boolean;
}): React.ReactElement {
  const [q, setQ] = useState("");
  const noun = props.noun ?? props.title.toLowerCase();
  const clearAll = (): void => {
    setQ("");
    props.onClearFilters?.();
  };
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

  const state = listState(!props.loading, props.rows.length, filtered.length);

  return (
    <section className="list-page">
      <PageHead
        title={props.title}
        {...(props.subtitle ? { subtitle: props.subtitle } : {})}
        search={{ value: q, onChange: setQ, noun }}
        {...(props.toolbar ? { actions: props.toolbar } : {})}
        {...(props.tabs ? { tabs: props.tabs } : {})}
      />
      {props.filters && <div className="list-filters">{props.filters}</div>}
      {/* Its line is kept while loading, so the table does not drop when the count arrives. */}
      <div className="list-meta ops-muted" {...(state === "loading" ? { "aria-hidden": true } : {})}>
        {state === "loading" ? "\u00a0" : `${filtered.length} of ${props.rows.length}`}
      </div>
      <div className={`ops-table-wrap list-table${props.stackOnPhone ? " list-table--stack" : ""}`}>
        <table
          className={`ops-table ${props.fixedLayout ? "ops-table--fixed" : ""}`}
        >
          <TableHead columns={props.columns.map((c) => ({ label: c.header, ...(c.width ? { width: c.width } : {}) }))} />
          {/* Mounted again when the rows arrive, so they come in as every page's content does. */}
          <tbody data-rows="" key={state === "loading" ? "loading" : "read"} className={state === "loading" ? undefined : "arrive"}>
            {state === "loading" && <EmptyState loading variant="row" columns={props.columns.length} />}
            {state === "empty" && (
              <EmptyState variant="row" columns={props.columns.length}>
                {props.empty ?? `No ${noun} yet.`}
              </EmptyState>
            )}
            {state === "no-match" && <EmptyState variant="row" columns={props.columns.length} query={{ noun, onClear: clearAll }} />}
            {filtered.map((row, i) => {
              const group = props.groupBy?.(row);
              const previous =
                i > 0 ? props.groupBy?.(filtered[i - 1]!) : undefined;
              return (
                <Fragment key={props.rowKey(row)}>
                  {group && group !== previous ? (
                    <tr className={`table-group list-group ${props.collapsible ? "is-foldable" : ""} ${group && folded.has(group) ? "is-folded" : ""}`}>
                      <th colSpan={props.columns.length} scope="colgroup">
                        <GroupHead
                          as="h3"
                          count={filtered.filter((r) => props.groupBy?.(r) === group).length}
                          title={
                            props.collapsible ? (
                              <button type="button" className="list-group-fold" aria-expanded={!folded.has(group)} onClick={() => toggleFold(group)}>
                                <span className="list-group-caret" aria-hidden="true">{folded.has(group) ? "▸" : "▾"}</span>
                                {group}
                              </button>
                            ) : (
                              group
                            )
                          }
                        />
                      </th>
                    </tr>
                  ) : null}
                  {!(props.collapsible && group && folded.has(group)) && (
                    <tr
                      className="ops-row-click"
                      onClick={() => props.onRowClick(row)}
                      {...rowKeys(() => props.onRowClick(row))}
                    >
                      {props.columns.map((c) => (
                        <td key={c.key} data-col={c.key} data-stack={c.stack} data-label={c.stackLabel ? c.header : undefined}>
                          {c.render(row)}
                        </td>
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
