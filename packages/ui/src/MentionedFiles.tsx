import { useEffect, useState, type ReactElement } from "react";

import { api } from "./api.js";
import { FileIcon, previewable } from "./FileIcon.js";
import { FilePreview, bytes } from "./FilePreview.js";
import { Thumb } from "./FileThumb.js";
import { hrefFor } from "./routes.js";

/**
 * The files a message talks about, laid out under it.
 *
 * A chip in a sentence says "this file exists"; it does not show it, and
 * getting to it meant a page change to Files. When KOS mentions a file or a
 * folder, a card for each sits under the message: a thumbnail for a
 * picture, the kind's glyph otherwise, the size, and the two things you want
 * to do with it, look and download. A file opens in the popup preview, a
 * folder opens in Files.
 */

/** `@file:` mentions as the Markdown chips read them: a bare path, or a bracketed one. */
const FILE_MENTION = /@file:(?:\[([^\]]+)\]|([A-Za-z0-9._/-]*[A-Za-z0-9_/-]))/g;

/** The distinct paths a message mentions, in the order they appear. */
export function mentionedPaths(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(FILE_MENTION)) {
    const path = (m[1] ?? m[2] ?? "").trim().replace(/^\.?\//, "").replace(/\/+$/, "");
    if (path && !out.includes(path)) out.push(path);
  }
  return out;
}

export type MentionedKind = "file" | "folder" | "missing";

export interface Mentioned {
  path: string;
  name: string;
  kind: MentionedKind;
  /** A file's size; a folder's number of entries. */
  size?: number;
  language?: string;
}

/** One lookup per path for the life of the page: a chat lists the same file many times. */
const known = new Map<string, Promise<Mentioned>>();

function lookup(path: string): Promise<Mentioned> {
  const cached = known.get(path);
  if (cached) return cached;
  const name = path.split("/").pop() ?? path;
  const p = api
    .file(path)
    .then((f): Mentioned => ({ path, name, kind: "file", size: f.size, ...(f.language ? { language: f.language } : {}) }))
    .catch(() =>
      api
        .files(path)
        .then((d): Mentioned => ({ path, name, kind: "folder", size: d.entries.length }))
        .catch((): Mentioned => ({ path, name, kind: "missing" })),
    );
  known.set(path, p);
  return p;
}

/** Forget a lookup, so a file written later is seen for what it now is. */
export function forgetMentioned(path?: string): void {
  if (path) known.delete(path);
  else known.clear();
}

function sub(m: Mentioned): string {
  if (m.kind === "missing") return "not found";
  if (m.kind === "folder") return `folder · ${m.size ?? 0} item${m.size === 1 ? "" : "s"}`;
  return `${bytes(m.size ?? 0)}${m.language && m.language !== "text" ? ` · ${m.language}` : ""}`;
}

export function MentionedFiles({ text }: { text: string }): ReactElement | null {
  const paths = mentionedPaths(text);
  const [items, setItems] = useState<Mentioned[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    if (paths.length === 0) {
      setItems([]);
      return;
    }
    let cancelled = false;
    void Promise.all(paths.map(lookup)).then((all) => {
      if (!cancelled) setItems(all);
    });
    return () => {
      cancelled = true;
    };
    // The paths are derived from the text; the text is the dependency.
  }, [text]);

  if (paths.length === 0 || items.length === 0) return null;
  const files = items.filter((m) => m.kind === "file").map((m) => m.path);

  return (
    <div className="mfiles" aria-label="Files mentioned">
      {items.map((m) => {
        const href = hrefFor({ name: "files", path: m.path });
        const act = (): void => {
          if (m.kind === "file") setOpen(m.path);
          else if (m.kind === "folder") window.location.hash = href.replace(/^#/, "");
        };
        return (
          <div key={m.path} className={`mfile mfile--${m.kind}`} title={m.path}>
            <button type="button" className="mfile-main" onClick={act} disabled={m.kind === "missing"}>
              {m.kind === "file" && previewable(m.name) ? (
                <Thumb path={m.path} name={m.name} />
              ) : (
                <span className={`mfile-glyph mfile-glyph--${m.kind}`}>
                  <FileIcon name={m.name} kind={m.kind === "folder" ? "dir" : "file"} size={15} />
                </span>
              )}
              <span className="mfile-text">
                <span className="mfile-name">{m.name}</span>
                <span className="mfile-sub">{sub(m)}</span>
              </span>
            </button>
            {m.kind !== "missing" && (
              <span className="mfile-acts">
                {m.kind === "file" && (
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Download ${m.name}`}
                    title="Download"
                    onClick={() => void api.downloadFile(m.path).catch(() => {})}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 3v12M6 11l6 6 6-6M4 21h16" />
                    </svg>
                  </button>
                )}
                <a className="icon-btn" href={href} aria-label={`Open ${m.name} in Files`} title="Open in Files">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
                  </svg>
                </a>
              </span>
            )}
          </div>
        );
      })}
      <FilePreview
        path={open}
        siblings={files}
        onStep={setOpen}
        onClose={() => setOpen(null)}
        actions={
          open && (
            <>
              <a className="btn btn--sm" href={hrefFor({ name: "files", path: open })} onClick={() => setOpen(null)}>
                Open in Files
              </a>
              <button type="button" className="btn btn--sm" onClick={() => void api.downloadFile(open).catch(() => {})}>
                Download
              </button>
            </>
          )
        }
      />
    </div>
  );
}
