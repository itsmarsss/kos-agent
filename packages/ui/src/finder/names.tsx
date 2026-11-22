import { useLayoutEffect, useRef, useState, type ReactElement } from "react";

/**
 * A name on one line, cut in the middle as Finder cuts it when it does not
 * fit: the start, an ellipsis, and the end with a file's extension kept,
 * so "Early_Careers_…Software.pdf" still says what it is. The whole name is
 * its tooltip and what assistive tech reads.
 */

const ELLIPSIS = "…";
/** The longest ending read as an extension: longer, the dot is part of the name. */
const EXT_MAX = 8;

/** A file's name as its stem and extension (".pdf"); a folder, or a name with no extension, is all stem. */
export function splitExtension(name: string, isFile: boolean): [string, string] {
  const dot = name.lastIndexOf(".");
  if (!isFile || dot <= 0 || name.length - dot - 1 > EXT_MAX || dot === name.length - 1) return [name, ""];
  return [name.slice(0, dot), name.slice(dot)];
}

/**
 * The longest middle-cut form of `name` that `fits`, the stem's start and
 * end kept in balance, a file's extension always kept; the name itself when
 * it fits whole, and only the ellipsis and extension when nothing else does.
 */
export function middleEllipsis(name: string, fits: (text: string) => boolean, isFile = true): string {
  if (fits(name)) return name;
  const [stem, ext] = splitExtension(name, isFile);
  const cut = (keep: number): string => `${stem.slice(0, Math.ceil(keep / 2))}${ELLIPSIS}${stem.slice(stem.length - Math.floor(keep / 2))}${ext}`;
  let lo = 0;
  let hi = stem.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(cut(mid))) lo = mid;
    else hi = mid - 1;
  }
  return cut(lo);
}

let canvas: CanvasRenderingContext2D | null | undefined;
/** How wide `text` is drawn in `font`, or undefined where nothing can measure (jsdom). */
function measure(text: string, font: string): number | undefined {
  if (canvas === undefined) {
    try {
      canvas = typeof OffscreenCanvas === "function" ? (new OffscreenCanvas(1, 1).getContext("2d") as unknown as CanvasRenderingContext2D | null) : null;
    } catch {
      canvas = null;
    }
  }
  if (!canvas) return undefined;
  canvas.font = font;
  return canvas.measureText(text).width;
}

/** One observer for every name on screen, each told its new width. */
const watched = new Map<Element, (width: number) => void>();
let observer: ResizeObserver | null = null;
function watch(el: Element, onWidth: (width: number) => void): () => void {
  if (typeof ResizeObserver !== "function") return () => undefined;
  observer ??= new ResizeObserver((entries) => {
    for (const entry of entries) if (entry.target) watched.get(entry.target)?.(entry.contentRect.width);
  });
  watched.set(el, onWidth);
  observer.observe(el);
  return () => {
    watched.delete(el);
    if (watched.size) return observer?.unobserve(el);
    // Nothing left to watch: let the observer go, so the next names start a fresh one.
    observer?.disconnect();
    observer = null;
  };
}

/** The name as it fits its box: the box fills the room it is given, and the text is cut to it. */
export function FitName({ name, isFile, className }: { name: string; isFile: boolean; className: string }): ReactElement {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(name);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const fit = (width: number): void => {
      const font = getComputedStyle(el).font;
      // A pixel spare: the canvas and the line can round apart.
      const room = width - 1;
      if (measure(name, font) === undefined || width <= 0) return setShown(name);
      setShown(middleEllipsis(name, (text) => (measure(text, font) ?? 0) <= room, isFile));
    };
    fit(el.clientWidth);
    return watch(el, fit);
  }, [name, isFile]);
  if (shown === name) {
    return (
      <span ref={ref} className={className} title={name}>
        {name}
      </span>
    );
  }
  return (
    <span ref={ref} className={className} title={name}>
      <span aria-hidden="true">{shown}</span>
      <span className="sr-only">{name}</span>
    </span>
  );
}
