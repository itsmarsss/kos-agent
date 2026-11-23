import { useRef, useState, type ReactElement, type ReactNode } from "react";

import { ChevronLeft, ChevronRight, Chips, ColumnsIcon, FolderPlusIcon, GridIcon, IconButton, InfoIcon, ListIcon, MoreIcon, SearchField, SearchIcon, UploadIcon } from "@kos/kit";

import { Select } from "../Select.js";
import type { FinderView, Sort, SortKey } from "./model.js";

/**
 * The bar over the files: back and forward, where you are, how it is shown
 * and sorted, what can be done here, and the search. It is one row at any
 * width: in a narrow Finder (a container query on the Finder, not the
 * window) the tools fold into one ⋯ menu and the search into a button that
 * opens the field in the title's place.
 */

export interface ToolbarProps {
  title: ReactNode;
  back?: () => void;
  forward?: () => void;
  view?: FinderView;
  views: FinderView[];
  onView: (view: FinderView) => void;
  sort: Sort;
  onSort: (sort: Sort) => void;
  /** The sort as a menu: only where nothing else sorts (icons, columns); the list's headers sort it. */
  sortMenu: boolean;
  /** Off where there is nothing to search: the trash. */
  searchable: boolean;
  query: string;
  onQuery: (q: string) => void;
  contents: boolean;
  onContents: (contents: boolean) => void;
  /** Absent where nothing can be made: the trash, Recents. */
  onNewFolder?: () => void;
  onUpload?: () => void;
  uploading: { done: number; total: number } | null;
  onInfo?: () => void;
  onActions?: (button: HTMLElement) => void;
  /** The narrow bar's one menu: the view, the sort, and what the wide bar's buttons do. */
  onMore?: (button: HTMLElement) => void;
}

const VIEW_CHOICES: Record<FinderView, [FinderView, ReactNode, string]> = {
  // Named in words a screen reader says, beside the mark: an icon alone left the button nameless.
  list: ["list", <><ListIcon title="" /><span className="sr-only">View as a list</span></>, "View as a list (Cmd+1)"],
  columns: ["columns", <><ColumnsIcon title="" /><span className="sr-only">View as columns</span></>, "View as columns (Cmd+2)"],
  gallery: ["gallery", <><GridIcon title="" /><span className="sr-only">View as icons</span></>, "View as icons (Cmd+3)"],
};

export const SORT_CHOICES: { value: SortKey; label: string }[] = [
  { value: "name", label: "Name" },
  { value: "kind", label: "Kind" },
  { value: "modified", label: "Date modified" },
  { value: "size", label: "Size" },
];

export function Toolbar(p: ToolbarProps): ReactElement {
  const [searchOpen, setSearchOpen] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const searching = searchOpen || p.query !== "";
  return (
    <div className={`finder-toolbar${searching ? " is-searching" : ""}`}>
      <div className="finder-nav">
        <IconButton label="Back" disabled={!p.back} onClick={p.back}>
          <ChevronLeft size={15} title="" />
        </IconButton>
        <IconButton label="Forward" disabled={!p.forward} onClick={p.forward}>
          <ChevronRight size={15} title="" />
        </IconButton>
        <div className="finder-title" role="heading" aria-level={2}>
          {p.title}
        </div>
      </div>
      <div className="finder-tools">
        <div className="finder-tools-wide">
          {p.view && <Chips small label="View" options={p.views.map((v) => VIEW_CHOICES[v])} selected={p.view} onChoose={p.onView} />}
          {p.sortMenu && <Select className="finder-sortby" label="Sort by" value={p.sort.key} options={SORT_CHOICES} onChange={(key) => p.onSort({ key: key as SortKey, desc: key === "modified" || key === "size" })} />}
          {p.onActions && (
            <IconButton label="Actions" onClick={(e) => p.onActions?.(e.currentTarget)}>
              <MoreIcon />
            </IconButton>
          )}
          {p.onNewFolder && (
            <IconButton label="New folder" onClick={p.onNewFolder}>
              <FolderPlusIcon />
            </IconButton>
          )}
          {p.onUpload && (
            <IconButton label={p.uploading ? `Uploading ${p.uploading.done} of ${p.uploading.total}` : "Upload"} disabled={p.uploading !== null} onClick={p.onUpload}>
              <UploadIcon size={15} />
            </IconButton>
          )}
          {p.onInfo && (
            <IconButton label="Get Info" onClick={p.onInfo}>
              <InfoIcon />
            </IconButton>
          )}
        </div>
        {p.searchable && (
          <SearchField
            className="finder-search"
            inputRef={field}
            noun="this folder"
            label="Search this folder and below"
            value={p.query}
            onChange={p.onQuery}
            onBlur={() => setSearchOpen(false)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") {
                e.preventDefault();
                p.onQuery("");
                setSearchOpen(false);
              }
            }}
          />
        )}
        <div className="finder-tools-narrow">
          {p.searchable && !searching && (
            <IconButton
              label="Search"
              onClick={() => {
                setSearchOpen(true);
                // The field is drawn once the bar knows it is searching.
                requestAnimationFrame(() => field.current?.focus());
              }}
            >
              <SearchIcon size={15} title="" />
            </IconButton>
          )}
          {p.onMore && (
            <IconButton label="More" onClick={(e) => p.onMore?.(e.currentTarget)}>
              <MoreIcon />
            </IconButton>
          )}
        </div>
      </div>
      {p.query && <Chips small label="Search in" options={[["names", "Names"], ["contents", "Contents", "Search inside text files too"]]} selected={p.contents ? "contents" : "names"} onChoose={(v) => p.onContents(v === "contents")} />}
    </div>
  );
}
