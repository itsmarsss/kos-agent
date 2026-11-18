import type { ReactElement, ReactNode } from "react";

import { ChevronLeft, ChevronRight, Chips, ColumnsIcon, FolderPlusIcon, GridIcon, IconButton, InfoIcon, ListIcon, MoreIcon, SearchIcon, UploadIcon } from "@kos/kit";

import { Select } from "../Select.js";
import type { FinderView, Sort, SortKey } from "./model.js";

/**
 * The bar over the files: back and forward, where you are, how it is shown
 * and sorted, what can be done here, and the search.
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
}

const VIEW_CHOICES: Record<FinderView, [FinderView, ReactNode, string]> = {
  list: ["list", <ListIcon key="list" />, "as List (Cmd+1)"],
  columns: ["columns", <ColumnsIcon key="columns" />, "as Columns (Cmd+2)"],
  gallery: ["gallery", <GridIcon key="gallery" />, "as Icons (Cmd+3)"],
};

export function Toolbar(p: ToolbarProps): ReactElement {
  return (
    <div className="finder-toolbar">
      <div className="finder-nav">
        <IconButton label="Back" disabled={!p.back} onClick={p.back}>
          <ChevronLeft size={15} title="" />
        </IconButton>
        <IconButton label="Forward" disabled={!p.forward} onClick={p.forward}>
          <ChevronRight size={15} title="" />
        </IconButton>
        <h2 className="finder-title">{p.title}</h2>
      </div>
      <div className="finder-tools">
        {p.view && <Chips small label="View" options={p.views.map((v) => VIEW_CHOICES[v])} selected={p.view} onChoose={p.onView} />}
        {p.view && p.view !== "list" && (
          <Select
            className="finder-sortby"
            label="Sort by"
            value={p.sort.key}
            options={[
              { value: "name", label: "Name" },
              { value: "kind", label: "Kind" },
              { value: "modified", label: "Date Modified" },
              { value: "size", label: "Size" },
            ]}
            onChange={(key) => p.onSort({ key: key as SortKey, desc: key === "modified" || key === "size" })}
          />
        )}
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
        {p.searchable && (
        <label className="finder-search">
          <SearchIcon size={13} title="" />
          <input
            type="search"
            value={p.query}
            placeholder="Search"
            aria-label="Search this folder and below"
            onChange={(e) => p.onQuery(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") p.onQuery("");
            }}
          />
        </label>
        )}
        {p.query && <Chips small label="Search in" options={[["names", "Names"], ["contents", "Contents", "Search inside text files too"]]} selected={p.contents ? "contents" : "names"} onChoose={(v) => p.onContents(v === "contents")} />}
      </div>
    </div>
  );
}
