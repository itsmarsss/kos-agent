import { useEffect, useRef, useState, type ReactElement } from "react";

import { api } from "./api.js";
import { FileIcon, previewable } from "./FileIcon.js";

/** Files the server draws a thumbnail of: an iWork file's own preview, a picture the browser does not draw. */
const DRAWN = /\.(pages|key|numbers|heic|heif|avif|tiff?)$/i;
/** Thumbnails the server could not draw this session, so a folder is not asked twice. */
const UNDRAWN = new Set<string>();

/** Whether a file has a picture of itself to show: an image's own bytes, or a document the server may draw. */
export function hasThumb(name: string): boolean {
  return previewable(name) || DRAWN.test(name);
}

/**
 * An image drawn from its own bytes, or a document as the server draws it,
 * fetched only once it is near the screen; the kind's mark until then, and
 * for anything that has no picture.
 *
 * A folder of a few hundred photographs should cost a few hundred kilobytes to
 * look at, not all of them at once, so the fetch waits for the tile to come
 * into view. The object URL is revoked on the way out; without that, scrolling
 * a large folder leaks every image it drew.
 */
export function Thumb({ path, name, edge = 256, iconSize = 30, version }: { path: string; name: string; edge?: number; iconSize?: number; version?: number }): ReactElement {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!el || near) return;
    const observer = new IntersectionObserver(
      (records) => {
        if (records.some((r) => r.isIntersecting)) setNear(true);
      },
      { rootMargin: "300px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [near]);

  useEffect(() => {
    if (!near || !hasThumb(name) || UNDRAWN.has(path)) return;
    let revoked: string | null = null;
    let cancelled = false;
    const fetched = previewable(name) ? api.imageUrl(path) : api.thumbUrl(path, edge);
    void fetched
      .then((u) => {
        if (u === null) {
          UNDRAWN.add(path);
          if (!cancelled) setFailed(true);
          return;
        }
        if (cancelled) {
          URL.revokeObjectURL(u);
          return;
        }
        revoked = u;
        setUrl(u);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [near, path, name, edge, version]);

  return (
    <div className={`files-thumb${url && !failed ? " has-picture" : ""}${url && !previewable(name) ? " is-document" : ""}`} ref={box}>
      {url && !failed ? (
        <img src={url} alt={name} loading="lazy" draggable={false} />
      ) : (
        <FileIcon name={name} kind="file" size={iconSize} />
      )}
    </div>
  );
}

/** The image itself, when the thing being viewed is a picture. */
export function ImageView({ path }: { path: string }): ReactElement {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let revoked: string | null = null;
    let cancelled = false;
    void api
      .imageUrl(path)
      .then((u) => {
        if (cancelled) {
          URL.revokeObjectURL(u);
          return;
        }
        revoked = u;
        setUrl(u);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [path]);

  if (error) return <p className="hint">{error}</p>;
  if (!url) return <p className="hint">Loading…</p>;
  return <img className="files-image" src={url} alt={path} />;
}
