import type { ReactElement } from "react";

/**
 * What a file is, at a glance.
 *
 * A folder full of identical dots tells you nothing, and the name alone makes
 * you read every row to find the one thing you came for. These are grouped by
 * what you would do with the file rather than by extension, so a .ts and a .py
 * look alike: both are code, and which language it is is already in the name.
 */

export type FileClass =
  | "dir"
  | "image"
  | "code"
  | "text"
  | "doc"
  | "sheet"
  | "deck"
  | "pdf"
  | "data"
  | "archive"
  | "audio"
  | "video"
  | "file";

const BY_EXTENSION: Record<string, FileClass> = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image",
  avif: "image", bmp: "image", ico: "image", svg: "image",

  ts: "code", tsx: "code", js: "code", jsx: "code", mjs: "code", cjs: "code",
  py: "code", rb: "code", go: "code", rs: "code", java: "code", c: "code",
  h: "code", cpp: "code", sh: "code", css: "code", html: "code", sql: "code",

  md: "text", markdown: "text", txt: "text", log: "text",

  pdf: "pdf",
  doc: "doc", docx: "doc", docm: "doc", dotx: "doc", rtf: "doc", odt: "doc", pages: "doc",
  xls: "sheet", xlsx: "sheet", xlsm: "sheet", xlsb: "sheet", ods: "sheet", numbers: "sheet", csv: "sheet", tsv: "sheet",
  ppt: "deck", pptx: "deck", pptm: "deck", ppsx: "deck", pps: "deck", odp: "deck", key: "deck",

  json: "data", jsonl: "data", yaml: "data",
  yml: "data", toml: "data", xml: "data", db: "data", sqlite: "data",

  zip: "archive", tar: "archive", gz: "archive", tgz: "archive", rar: "archive",

  mp3: "audio", wav: "audio", m4a: "audio", aac: "audio", flac: "audio", ogg: "audio",
  mp4: "video", m4v: "video", mov: "video", webm: "video", avi: "video",
};

/**
 * Types the dashboard will draw from their own bytes. This mirrors the
 * server's allow-list, and leaves out SVG for the same reason: it is markup
 * that runs, so it is read as text rather than rendered as a picture.
 */
const PREVIEWABLE = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico",
]);

/** Whether this one can be shown as a picture rather than an icon. */
export function previewable(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot > 0 && PREVIEWABLE.has(name.slice(dot + 1).toLowerCase());
}

export function classify(name: string, kind: "dir" | "file"): FileClass {
  if (kind === "dir") return "dir";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "file";
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? "file";
}

/** A page outline, shared by every glyph that is a file rather than a folder. */
const PAGE = <path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9l-6-6Z" />;
const FOLD = <path d="M13 3v6h6" />;

const GLYPH: Record<FileClass, ReactElement> = {
  dir: <path d="M3 7a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.6.8l1 1.2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />,
  image: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="8.5" cy="10" r="1.5" />
      <path d="m4 17 4.5-4.5L12 16l3-3 5 5" />
    </>
  ),
  code: (
    <>
      {PAGE}
      {FOLD}
      <path d="m10.5 13-1.5 1.5 1.5 1.5M13.5 13l1.5 1.5-1.5 1.5" />
    </>
  ),
  text: (
    <>
      {PAGE}
      {FOLD}
      <path d="M8.5 13h5M8.5 16h3" />
    </>
  ),
  doc: (
    <>
      {PAGE}
      {FOLD}
      <path d="M8.5 12.5h7M8.5 15.5h7M8.5 18.5h4" />
    </>
  ),
  sheet: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M4 9.5h16M4 14.5h16M10 4v16" />
    </>
  ),
  deck: (
    <>
      <rect x="3" y="4.5" width="18" height="12" rx="1.5" />
      <path d="M12 16.5v3.5M8.5 20h7M7.5 9h5M7.5 12h8" />
    </>
  ),
  pdf: (
    <>
      {PAGE}
      {FOLD}
      <path d="M8 16.5h8M8 13.5h5" strokeWidth="2.2" />
    </>
  ),
  data: (
    <>
      <ellipse cx="12" cy="6" rx="7" ry="3" />
      <path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6" />
      <path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" />
    </>
  ),
  archive: (
    <>
      {PAGE}
      {FOLD}
      <path d="M11 12h2M11 15h2M11 18h2" />
    </>
  ),
  audio: (
    <>
      <path d="M9 18V6l11-2v12" />
      <circle cx="6.5" cy="18" r="2.5" />
      <circle cx="17.5" cy="16" r="2.5" />
    </>
  ),
  video: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M10 8.5v7l6-3.5-6-3.5Z" />
    </>
  ),
  file: (
    <>
      {PAGE}
      {FOLD}
    </>
  ),
};

export function FileIcon({
  name,
  kind,
  size = 16,
}: {
  name: string;
  kind: "dir" | "file";
  size?: number;
}): ReactElement {
  const cls = classify(name, kind);
  return (
    <svg
      className={`fi fi--${cls}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {GLYPH[cls]}
    </svg>
  );
}
