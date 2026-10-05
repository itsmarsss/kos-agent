import { useEffect, useRef, useState, type ReactElement } from "react";

import { api } from "./api.js";
import { FileIcon } from "./FileIcon.js";

/**
 * An image drawn from its own bytes, fetched only once it is near the screen.
 *
 * A folder of a few hundred photographs should cost a few hundred kilobytes to
 * look at, not all of them at once, so the fetch waits for the tile to come
 * into view. The object URL is revoked on the way out; without that, scrolling
 * a large folder leaks every image it drew.
 */
export function Thumb({ path, name }: { path: string; name: string }): ReactElement {
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
    if (!near) return;
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
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [near, path]);

  return (
    <div className="files-thumb" ref={box}>
      {url && !failed ? (
        <img src={url} alt={name} loading="lazy" />
      ) : (
        <FileIcon name={name} kind="file" size={30} />
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
