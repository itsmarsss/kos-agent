import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { AnimatePresence, m } from "motion/react";

import { api, type FileContent, type FileText } from "./api.js";
import { FileIcon, previewable } from "./FileIcon.js";
import { ImageView } from "./FileThumb.js";
import { highlights, tokenize } from "./highlight.js";
import { Markdown } from "./Markdown.js";
import { ease, spring } from "./motion.js";
import { hrefFor } from "./routes.js";

/**
 * A file, looked at in a window over the page.
 *
 * The project explorer is a narrow column, and a file opened inside it was
 * a strip of picture or a few lines of code with the folder gone from view.
 * A popup gives the file the whole window and leaves the folder where it
 * was, so the next file is one click (or one arrow key) away.
 */

/** How often the open file is re-read, so an agent's rewrite shows. */
const POLL_MS = 5000;

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function ago(ms: number): string {
  if (!ms) return "";
  const secs = Math.round((Date.now() - ms) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** A PDF, by name: shown as itself in the browser's own viewer. */
export function isPdfPath(path: string): boolean {
  return /\.pdf$/i.test(path);
}

/** Where the browser's viewer gets a PDF from. */
export function pdfViewUrl(path: string): string {
  return `/api/file/view?path=${encodeURIComponent(path)}`;
}

/** The file's contents, shown for what they are. */
export function FileBody({ file }: { file: FileContent }): ReactElement {
  if (file.omitted === "binary") {
    if (previewable(file.path)) return <ImageView path={file.path} />;
    if (isPdfPath(file.path)) return <iframe className="preview-frame" src={pdfViewUrl(file.path)} title={file.path.split("/").pop() ?? file.path} />;
    return <p className="hint preview-hint">Binary file. Download it, or open the workspace folder.</p>;
  }
  if (file.omitted === "too-large") return <p className="hint preview-hint">Too large to show here. Download it instead.</p>;
  if (file.text === undefined) return <p className="hint preview-hint">Nothing to show.</p>;
  if (file.language === "markdown") {
    return (
      <div className="preview-md">
        <Markdown text={file.text} />
      </div>
    );
  }
  // Text read out of a Word, Excel or PowerPoint file: said so, since it is
  // the document's words and not the document.
  if (file.extracted) {
    return (
      <div className="preview-extracted">
        <p className="hint preview-extracted-note">Text read from the document ({file.extracted}). Download it for the file itself.</p>
        <pre className="preview-pre">{file.text}</pre>
      </div>
    );
  }
  return (
    <pre className="preview-pre">
      {highlights(file.language)
        ? tokenize(file.text, file.language).map((t, i) =>
            t.kind === "plain" ? (
              t.text
            ) : (
              <span key={i} className={`tok tok--${t.kind}`}>
                {t.text}
              </span>
            ),
          )
        : file.text}
    </pre>
  );
}

/** A file that is not on disk, an attachment still in the composer, shown by the same window under a key of its own. */
export interface LocalFile {
  name: string;
  text?: string;
  /** A data URI, for an image. */
  src?: string;
  size?: number;
}

/** A document whose words can be shown instead of the file: a PDF, or an Office file read as text. */
export function hasRawText(file: Pick<FileContent, "path" | "extracted">): boolean {
  return isPdfPath(file.path) || !!file.extracted;
}

/** The words of a document, fetched once wanted. */
export function useRawText(path: string | null, wanted: boolean): { raw: FileText | null; error: string | null } {
  const [raw, setRaw] = useState<FileText | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setRaw(null);
    setError(null);
    if (!path || !wanted) return undefined;
    let cancelled = false;
    void api
      .fileText(path)
      .then((t) => {
        if (!cancelled) setRaw(t);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [path, wanted]);
  return { raw, error };
}

/** File or Raw: the document itself, or the words KOS reads out of it. */
export function RawToggle({ raw, onChange }: { raw: boolean; onChange: (raw: boolean) => void }): ReactElement {
  return (
    <div className="seg seg--sm" role="group" aria-label="View as">
      <button type="button" className={`seg-btn ${raw ? "" : "is-on"}`} onClick={() => onChange(false)}>
        File
      </button>
      <button type="button" className={`seg-btn ${raw ? "is-on" : ""}`} title="The words read out of the document, as KOS reads them" onClick={() => onChange(true)}>
        Raw
      </button>
    </div>
  );
}

/** The words of a document, as KOS reads them. */
export function RawBody({ path }: { path: string }): ReactElement {
  const { raw, error } = useRawText(path, true);
  if (error) {
    return (
      <p className="ops-alert ops-alert--err preview-hint" role="alert">
        {error}
      </p>
    );
  }
  if (!raw) return <p className="hint preview-hint">Reading…</p>;
  return (
    <div className="preview-extracted">
      {raw.extracted && <p className="hint preview-extracted-note">The words read out of the document ({raw.extracted}), as KOS reads them.</p>}
      <pre className="preview-pre">{raw.text}</pre>
    </div>
  );
}

/** Open in Files and Download, for a window opened from anywhere but the Files page. */
export function PreviewLinks({ path, onOpenInFiles }: { path: string; onOpenInFiles?: () => void }): ReactElement {
  return (
    <>
      <a className="btn btn--sm" href={hrefFor({ name: "files", path })} onClick={onOpenInFiles}>
        Open in Files
      </a>
      <button type="button" className="btn btn--sm" onClick={() => void api.downloadFile(path).catch(() => {})}>
        Download
      </button>
    </>
  );
}

export interface FilePreviewProps {
  /** The file being looked at; nothing open when absent. */
  path: string | null;
  /** The files beside it, in order, for stepping through the folder. */
  siblings?: string[];
  onStep?: (path: string) => void;
  onClose: () => void;
  /** Rendered in the header: Open in Files, Download, the menu. */
  actions?: ReactNode;
  /** Off screen: the file is kept but not re-read. */
  paused?: boolean;
  /** Files that are not on disk, by the key they are opened under; shown without a fetch. */
  locals?: Record<string, LocalFile>;
}

export function FilePreview({ path, siblings = [], onStep, onClose, actions, paused = false, locals }: FilePreviewProps): ReactElement | null {
  const [file, setFile] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The words instead of the document; back to the file on every step.
  const [raw, setRaw] = useState(false);
  useEffect(() => setRaw(false), [path]);

  const local = path ? locals?.[path] : undefined;
  const isLocal = local !== undefined;
  const at = path ? siblings.indexOf(path) : -1;
  const prev = at > 0 ? siblings[at - 1] : undefined;
  const next = at >= 0 && at < siblings.length - 1 ? siblings[at + 1] : undefined;

  useEffect(() => {
    if (!path || isLocal) {
      setFile(null);
      setError(null);
      return;
    }
    if (paused) return;
    let cancelled = false;
    const read = (): void => {
      void api
        .file(path)
        .then((f) => {
          if (cancelled) return;
          setFile((cur) => (cur && cur.path === f.path && cur.modifiedAt === f.modifiedAt && cur.size === f.size ? cur : f));
          setError(null);
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        });
    };
    read();
    const t = setInterval(() => {
      if (document.visibilityState !== "hidden") read();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [path, paused, isLocal]);

  useEffect(() => {
    if (!path) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLElement && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && prev && onStep) onStep(prev);
      else if (e.key === "ArrowRight" && next && onStep) onStep(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [path, prev, next, onStep, onClose]);

  const name = local?.name ?? (path ? (path.split("/").pop() ?? path) : "");
  // The file in hand may still be the previous one for a beat after stepping.
  const shown: FileContent | null =
    local && path
      ? {
          path,
          size: local.size ?? local.text?.length ?? 0,
          modifiedAt: 0,
          language: local.name.endsWith(".md") ? "markdown" : "text",
          ...(local.text !== undefined ? { text: local.text } : { omitted: "binary" as const }),
        }
      : file && path && file.path === path
        ? file
        : null;
  const image = !!path && (local ? !!local.src : previewable(path));
  const rawable = !!shown && !local && hasRawText(shown);

  return createPortal(
    <AnimatePresence>
      {path && (
        <>
          <m.div className="preview-backdrop" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={ease} />
          <div className="preview-wrap">
            <m.div
              className="preview"
              role="dialog"
              aria-modal="true"
              aria-label={name}
              initial={{ opacity: 0, scale: 0.98, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.99, y: 4 }}
              transition={spring}
            >
              <header className="preview-head">
                <FileIcon name={name} kind="file" />
                <span className="preview-name" title={path}>
                  {name}
                </span>
                {shown && (
                  <span className="preview-meta">
                    {bytes(shown.size)}
                    {shown.language && shown.language !== "text" && shown.omitted !== "binary" ? ` · ${shown.language}` : ""}
                    {shown.modifiedAt ? ` · ${ago(shown.modifiedAt)}` : ""}
                  </span>
                )}
                <span className="preview-acts">
                  {siblings.length > 1 && at >= 0 && (
                    <span className="preview-step">
                      <button type="button" className="icon-btn" aria-label="Previous file" disabled={!prev} onClick={() => prev && onStep?.(prev)}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="m15 6-6 6 6 6" />
                        </svg>
                      </button>
                      <span className="preview-count">
                        {at + 1} of {siblings.length}
                      </span>
                      <button type="button" className="icon-btn" aria-label="Next file" disabled={!next} onClick={() => next && onStep?.(next)}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="m9 6 6 6-6 6" />
                        </svg>
                      </button>
                    </span>
                  )}
                  {rawable && <RawToggle raw={raw} onChange={setRaw} />}
                  {actions}
                  <button type="button" className="icon-btn preview-close" aria-label="Close" onClick={onClose}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                </span>
              </header>
              <div className={`preview-body${image ? " preview-body--image" : ""}`}>
                {error && (
                  <p className="ops-alert ops-alert--err preview-hint" role="alert">
                    {error}
                  </p>
                )}
                {!shown && !error && <p className="hint preview-hint">Loading…</p>}
                {shown && local?.src && <img className="files-image" src={local.src} alt={name} />}
                {shown && local && !local.src && local.text === undefined && (
                  <p className="hint preview-hint">Attached. Once sent it is kept in the workspace and shown here as the file.</p>
                )}
                {shown && (!local || (!local.src && local.text !== undefined)) && (raw && rawable && path ? <RawBody path={path} /> : <FileBody file={shown} />)}
              </div>
            </m.div>
          </div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
}
