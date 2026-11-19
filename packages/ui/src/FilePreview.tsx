import { useEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";

import { AnimatePresence, m } from "motion/react";
import { ChevronLeft, ChevronRight, Chips, CloseIcon, ease, IconButton, Markdown, spring } from "@kos/kit";
import { bytesWords } from "@kos/shared";

import { api, type FileContent, type FileText } from "./api.js";
import { FileIcon, previewable } from "./FileIcon.js";
import { ImageView, isSvgPath, svgDataUrl } from "./FileThumb.js";
import { highlights, tokenize } from "./highlight.js";
import { isOfficePath, OfficeBody } from "./OfficeView.js";
import { hrefFor } from "./routes.js";
import { Signed } from "./signed.js";
import { agoWords } from "./schedulewords.js";

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

/** A PDF, by name: shown as itself in the browser's own viewer. */
export function isPdfPath(path: string): boolean {
  return /\.pdf$/i.test(path);
}

/** Where the browser's viewer gets a PDF from. */
export function pdfViewUrl(path: string): string {
  // The name at the end of the address too: a viewer that names its download by the URL saves "plan.pdf", not "view".
  return `/api/file/view/${encodeURIComponent(path.split("/").pop() ?? path)}?path=${encodeURIComponent(path)}`;
}

const AUDIO = /\.(mp3|m4a|aac|wav|ogg|oga|flac)$/i;
const VIDEO = /\.(mp4|m4v|webm|mov)$/i;

/**
 * A sound or a film, streamed. Its address is signed for long enough to play
 * through and not renewed while it plays (that would start it over); if it
 * lapses anyway, the failed read signs it again and the player picks up
 * where it was.
 */
function Player({ kind, path }: { kind: "audio" | "video"; path: string }): ReactElement {
  const resume = useRef(0);
  return (
    <Signed url={api.mediaUrl(path)} renew={false}>
      {(src, again) => {
        const common = {
          controls: true,
          preload: "metadata" as const,
          src,
          onError: (e: SyntheticEvent<HTMLMediaElement>) => {
            const at = e.currentTarget.currentTime;
            if (again()) resume.current = at;
          },
          onLoadedMetadata: (e: SyntheticEvent<HTMLMediaElement>) => {
            if (!resume.current) return;
            e.currentTarget.currentTime = resume.current;
            resume.current = 0;
          },
        };
        return kind === "audio" ? <audio className="preview-audio" {...common} /> : <video className="preview-video" playsInline {...common} />;
      }}
    </Signed>
  );
}

/** JSON laid out to read, or the text as it is when it is not one JSON value (JSON Lines, a broken file). */
function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** A text file drawn as something other than its text under File (an SVG, laid-out JSON), so Raw shows the text itself. */
export function drawnFromText(file: Pick<FileContent, "path" | "text">): boolean {
  return file.text !== undefined && (isSvgPath(file.path) || /\.json$/i.test(file.path));
}

/** A file the window cannot draw, with the way to get at it. */
function Unshown({ path, why }: { path: string; why: string }): ReactElement {
  return (
    <div className="preview-hint preview-unshown">
      <p className="hint">{why}</p>
      <button type="button" className="btn btn--sm" onClick={() => void api.downloadFile(path).catch(() => {})}>
        Download
      </button>
    </div>
  );
}

/** The file's contents, shown for what they are; `raw` is the text as it is on disk, for a file drawn from its text. */
export function FileBody({ file, raw = false, line }: { file: FileContent; raw?: boolean; line?: number }): ReactElement {
  // A document, a workbook or a deck is drawn as itself; its words are a Raw away.
  if (isOfficePath(file.path)) return <OfficeBody path={file.path} version={`${file.modifiedAt}:${file.size}`} />;
  if (AUDIO.test(file.path)) return <Player kind="audio" path={file.path} />;
  if (VIDEO.test(file.path)) return <Player kind="video" path={file.path} />;
  if (file.omitted === "binary") {
    if (previewable(file.path)) return <ImageView path={file.path} />;
    if (isPdfPath(file.path)) return <Signed url={pdfViewUrl(file.path)} renew={false}>{(src) => <iframe className="preview-frame" src={src} title={file.path.split("/").pop() ?? file.path} />}</Signed>;
    return <Unshown path={file.path} why="This kind of file can't be shown here." />;
  }
  if (file.omitted === "too-large") return <Unshown path={file.path} why="Too large to show here." />;
  if (file.text === undefined) return <p className="hint preview-hint">Nothing to show.</p>;
  if (!raw && isSvgPath(file.path)) return <img className="files-image files-image--svg" src={svgDataUrl(file.text)} alt={file.path.split("/").pop() ?? file.path} />;
  // A line asked for is the file's own line: shown as written, not reflowed (pretty JSON) or drawn (markdown).
  if (line !== undefined) return <LinedText file={file} line={line} />;
  const text = !raw && /\.json$/i.test(file.path) ? prettyJson(file.text) : file.text;
  if (file.language === "markdown") {
    return (
      <div className="preview-md">
        <Markdown text={file.text} />
      </div>
    );
  }
  return <pre className="preview-pre">{coloured(text, file.language)}</pre>;
}

/** Text in its language's colours, where it has them. */
function coloured(text: string, language: FileContent["language"]): ReactNode {
  if (!highlights(language)) return text;
  return tokenize(text, language).map((t, i) =>
    t.kind === "plain" ? (
      t.text
    ) : (
      <span key={i} className={`tok tok--${t.kind}`}>
        {t.text}
      </span>
    ),
  );
}

/**
 * The text as it is on disk with one line lit and scrolled to: where a
 * search found it. The band is drawn in the text's own line height, so it
 * sits on the line however the density scales the type.
 */
function LinedText({ file, line }: { file: FileContent; line: number }): ReactElement {
  const band = useRef<HTMLSpanElement>(null);
  useEffect(() => band.current?.scrollIntoView({ block: "center" }), [line, file.path]);
  return (
    <pre className="preview-pre preview-pre--lined">
      <span ref={band} className="preview-line" aria-hidden="true" style={{ "--line": Math.max(0, line - 1) } as CSSProperties} />
      {coloured(file.text ?? "", file.language)}
    </pre>
  );
}

const ATTACHED_HINT_KEY = "kos.hint.attached";

/**
 * Whether to say, this once, what happens to an attachment: for two seconds
 * the first time one is looked at in this browser, and never again.
 */
function useAttachedHint(wanted: boolean): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!wanted) return undefined;
    let seen = true;
    try {
      seen = localStorage.getItem(ATTACHED_HINT_KEY) === "1";
      localStorage.setItem(ATTACHED_HINT_KEY, "1");
    } catch {
      // No storage: say nothing rather than say it every time.
    }
    if (seen) return undefined;
    setShown(true);
    const t = setTimeout(() => setShown(false), 2000);
    return () => clearTimeout(t);
  }, [wanted]);
  return shown;
}

/** A file that is not on disk, an attachment still in the composer, shown by the same window under a key of its own. */
export interface LocalFile {
  name: string;
  text?: string;
  /** A data URI, for an image. */
  src?: string;
  size?: number;
}

/** A document whose words can be shown instead of the file: a PDF, an Office file read as text, a table's own text. */
export function hasRawText(file: Pick<FileContent, "path" | "extracted">): boolean {
  return isPdfPath(file.path) || !!file.extracted || /\.(csv|tsv)$/i.test(file.path);
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
    <Chips
      small
      label="View as"
      options={[["file", "File"], ["raw", "Raw", "The words read out of the document, as KOS reads them"]]}
      selected={raw ? "raw" : "file"}
      onChoose={(v) => onChange(v === "raw")}
    />
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
  /** Opened as Quick Look from a file list: Space closes it too, and the up and down arrows step as well. */
  quickLook?: boolean;
  /** A line of `line.path` to show lit: where a search found it. */
  line?: { path: string; line: number };
}

export function FilePreview({ path, siblings = [], onStep, onClose, actions, paused = false, locals, quickLook = false, line }: FilePreviewProps): ReactElement | null {
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
      // Taken already: by a menu over the window, or by the file list that opened it, which steps its own selection.
      if (e.defaultPrevented) return;
      if (e.target instanceof HTMLElement && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
      // A player has its own keys: Space plays, the arrows seek.
      if (e.target instanceof HTMLMediaElement) return;
      const back = e.key === "ArrowLeft" || (quickLook && e.key === "ArrowUp");
      const on = e.key === "ArrowRight" || (quickLook && e.key === "ArrowDown");
      if (e.key === "Escape" || (quickLook && e.key === " ")) {
        e.preventDefault();
        onClose();
      } else if (back && prev && onStep) {
        e.preventDefault();
        onStep(prev);
      } else if (on && next && onStep) {
        e.preventDefault();
        onStep(next);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [path, prev, next, onStep, onClose, quickLook]);

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
  const attachedOnly = !!local && !local.src && local.text === undefined;
  const attachedHint = useAttachedHint(attachedOnly);
  const office = !!path && !local && isOfficePath(path);
  const drawn = !!shown && !local && drawnFromText(shown);
  const rawable = !!shown && !local && (hasRawText(shown) || drawn);

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
              aria-label={quickLook ? `Quick Look: ${name}` : name}
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
                    {bytesWords(shown.size)}
                    {shown.language && shown.language !== "text" && shown.omitted !== "binary" ? ` · ${shown.language}` : ""}
                    {shown.modifiedAt ? ` · ${agoWords(shown.modifiedAt)}` : ""}
                  </span>
                )}
                <span className="preview-acts">
                  {siblings.length > 1 && at >= 0 && (
                    <span className="preview-step">
                      <IconButton  label="Previous file" disabled={!prev} onClick={() => prev && onStep?.(prev)}>
                        <ChevronLeft size={14} title="" />
                      </IconButton>
                      <span className="preview-count">
                        {at + 1} of {siblings.length}
                      </span>
                      <IconButton  label="Next file" disabled={!next} onClick={() => next && onStep?.(next)}>
                        <ChevronRight size={14} title="" />
                      </IconButton>
                    </span>
                  )}
                  {rawable && <RawToggle raw={raw} onChange={setRaw} />}
                  {actions}
                </span>
                <IconButton className="preview-close" label="Close" onClick={onClose}>
                  <CloseIcon size={14} title="" />
                </IconButton>
              </header>
              <div className={`preview-body${image ? " preview-body--image" : ""}${office && !raw ? " preview-body--office" : ""}`}>
                {error && (
                  <p className="ops-alert ops-alert--err preview-hint" role="alert">
                    {error}
                  </p>
                )}
                {!shown && !error && <p className="hint preview-hint">Loading…</p>}
                {shown && local?.src && <img className="files-image" src={local.src} alt={name} />}
                {shown && attachedOnly && (
                  <div className="preview-attached">
                    <FileIcon name={name} kind="file" size={40} />
                    {attachedHint && <p className="hint">Kept in the workspace once sent.</p>}
                  </div>
                )}
                {shown && (!local || (!local.src && local.text !== undefined)) && (raw && rawable && path ? drawn ? <FileBody file={shown} raw /> : <RawBody path={path} /> : <FileBody file={shown} {...(line && line.path === shown.path ? { line: line.line } : {})} />)}
              </div>
            </m.div>
          </div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
}
