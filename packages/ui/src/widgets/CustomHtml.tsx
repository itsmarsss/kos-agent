import type { CustomHtmlWidget } from "@kos/shared";
import { useEffect, useRef, useState, type ReactElement } from "react";

import type { WidgetProps } from "./types.js";

/**
 * The escape hatch, contained. Agent-authored markup renders inside a sandboxed
 * iframe via srcdoc, never injected into the parent document.
 *
 * Scripts are allowed, because a widget that cannot run any is not an escape
 * hatch: a chart the library does not have, a small game, anything interactive
 * all need them. What is withheld is `allow-same-origin`, so the frame is
 * cross-origin to the dashboard and can reach neither its DOM, its storage, nor
 * its cookies. That pairing matters: a frame granted both could rewrite its own
 * sandbox attribute and escape. The worst a bad snippet can do is misbehave
 * inside its own box.
 */

/** Read a theme token off the shell so the frame matches the surrounding page. */
function token(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value === "" ? fallback : value;
}

/**
 * Models routinely write `<\/script>` because that is how a closing tag is
 * escaped *inside a JavaScript string*. In raw HTML it closes nothing: the
 * script block runs to the end of the document, never terminates, and the
 * whole page silently does nothing. The sequence has no valid meaning in HTML,
 * so repairing it costs nothing and turns a blank frame into a working one.
 */
function unescapeClosingTags(html: string): string {
  return html.replace(/<\\\//g, "</");
}

function frameDocument(html: string): string {
  const text = token("--text", "#e7ebf3");
  const muted = token("--muted", "#8b93a7");
  const line = token("--line", "#262b36");
  const scheme =
    typeof window === "undefined"
      ? "dark"
      : getComputedStyle(document.documentElement).colorScheme || "dark";
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    "<style>",
    `:root{color-scheme:${scheme};--text:${text};--muted:${muted};--line:${line};}`,
    "html,body{margin:0;background:transparent;color:var(--text);",
    "font:14px/1.45 'IBM Plex Sans',ui-sans-serif,system-ui,sans-serif;}",
    "a{color:inherit}img,table{max-width:100%}",
    "table{border-collapse:collapse}th,td{border-bottom:1px solid var(--line);",
    "padding:.35rem .4rem;text-align:left}th{color:var(--muted);font-weight:500}",
    "</style></head><body>",
    unescapeClosingTags(html),
    // The frame is cross-origin, so the parent cannot measure it. It reports
    // its own height instead, and keeps reporting as content settles.
    "<script>(function(){var r=function(){parent.postMessage({__kosHeight:",
    "Math.ceil(document.documentElement.scrollHeight)},'*')};",
    "if(window.ResizeObserver){new ResizeObserver(r).observe(document.documentElement)}",
    "addEventListener('load',r);setTimeout(r,50);r()})()<\/script>",
    "</body></html>",
  ].join("");
}

const DEFAULT_HEIGHT = 320;
const MAX_HEIGHT = 900;

export function CustomHtml({ widget }: WidgetProps): ReactElement {
  const w = widget as CustomHtmlWidget;
  const frameRef = useRef<HTMLIFrameElement>(null);
  const declared =
    typeof w.height === "number"
      ? Math.min(MAX_HEIGHT, Math.max(120, w.height))
      : undefined;
  const [measured, setMeasured] = useState<number | undefined>(undefined);

  // An explicit height wins; otherwise grow to fit what the frame reports, so
  // a 480px canvas is not silently cropped by a default.
  useEffect(() => {
    if (declared !== undefined) return;
    const onMessage = (e: MessageEvent): void => {
      if (e.source !== frameRef.current?.contentWindow) return;
      const h = (e.data as { __kosHeight?: unknown })?.__kosHeight;
      if (typeof h === "number" && Number.isFinite(h)) {
        setMeasured(Math.min(MAX_HEIGHT, Math.max(120, Math.ceil(h))));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [declared]);

  const height = declared ?? measured ?? DEFAULT_HEIGHT;
  return (
    <div className="kos-widget kos-custom-html">
      {w.title ? <div className="kos-widget-title">{w.title}</div> : null}
      <iframe
        className="kos-custom-frame"
        title={w.title ?? "custom html"}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        ref={frameRef}
        loading="lazy"
        style={{ height }}
        srcDoc={frameDocument(w.html)}
      />
    </div>
  );
}
