import type { CustomHtmlWidget } from "@kos/shared";
import type { ReactElement } from "react";

import type { WidgetProps } from "./types.js";

/**
 * The escape hatch, contained. Agent-authored markup renders inside a sandboxed
 * iframe via srcdoc, never injected into the parent document: an empty sandbox
 * attribute denies scripts, forms, popups, navigation and same-origin access, so
 * the worst a bad snippet can do is look wrong inside its own box.
 */

/** Read a theme token off the shell so the frame matches the surrounding page. */
function token(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value === "" ? fallback : value;
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
    html,
    "</body></html>",
  ].join("");
}

export function CustomHtml({ widget }: WidgetProps): ReactElement {
  const w = widget as CustomHtmlWidget;
  return (
    <div className="kos-widget kos-custom-html">
      {w.title ? <div className="kos-widget-title">{w.title}</div> : null}
      <iframe
        className="kos-custom-frame"
        title={w.title ?? "custom html"}
        sandbox=""
        referrerPolicy="no-referrer"
        loading="lazy"
        srcDoc={frameDocument(w.html)}
      />
    </div>
  );
}
