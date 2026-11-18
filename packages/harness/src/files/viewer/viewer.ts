import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";

import { PICTURE_FORMATS, TEXTUTIL_FORMATS, viewFormatOf } from "./convert.js";
import { hasTextutil, sharedQuickLook, textutilHtml } from "./macos.js";
import type { OfficeView, ViewFormat } from "@kos/shared";
import { defaultRunner, type Runner } from "./run.js";

/**
 * An Office file in the workspace, as a view: converted once per version
 * of the file and kept.
 *
 * The path is resolved by the caller through the jail; this reads the file,
 * checks its size, and hands the bytes to a bounded run (run.ts) or to
 * macOS's own readers (macos.ts), whose HTML is then cleaned in the same
 * bounded run. A version is its path, its modified time and its size, so a
 * file the agent rewrites is converted again and an unchanged one is not.
 */

/** Past this a document is not converted; it can still be downloaded. */
export const VIEW_INPUT_MAX = 30 * 1024 * 1024;
/** CSV and TSV past this are not drawn as a sheet; they are text to search, not a grid to scroll. */
const DELIMITED_MAX = 12 * 1024 * 1024;
/** What the kept views may hold together, by the length of their JSON. */
const CACHE_MAX = 96 * 1024 * 1024;
/** The picture of a first slide, where that is what the host can show. */
const PICTURE_EDGE = 1600;

export interface ViewerHost {
  run: Runner;
  textutil?: (bytes: Uint8Array, ext: string) => Promise<string>;
  quickLook?: (bytes: Uint8Array, ext: string, edge: number) => Promise<Buffer | undefined>;
}

export function defaultViewerHost(): ViewerHost {
  return {
    run: defaultRunner(),
    ...(hasTextutil() ? { textutil: textutilHtml } : {}),
    ...(sharedQuickLook ? { quickLook: sharedQuickLook } : {}),
  };
}

/** Whether a file of this name is shown by the viewers. */
export function isViewable(name: string): boolean {
  return viewFormatOf(name) !== undefined;
}

export class OfficeViewer {
  private readonly kept = new Map<string, { view: OfficeView; size: number }>();
  private keptSize = 0;
  /** Conversions under way, so two asks for one version convert it once. */
  private readonly pending = new Map<string, Promise<OfficeView>>();

  constructor(private readonly host: ViewerHost = defaultViewerHost()) {}

  /** The view of the file at `abs` (already through the jail), named `rel` for messages. */
  async view(abs: string, rel: string): Promise<OfficeView> {
    const format = viewFormatOf(rel);
    if (!format) throw new Error(`${rel} is not a document KOS shows`);
    const st = statSync(abs);
    if (!st.isFile()) throw new Error(`not a file: ${rel}`);
    const cap = format === "csv" || format === "tsv" ? DELIMITED_MAX : VIEW_INPUT_MAX;
    if (st.size > cap) throw new Error(`${rel} is ${Math.round(st.size / 1024 / 1024)} MB, past the ${cap / 1024 / 1024} MB shown here; download it instead`);
    const key = `${abs}\0${st.mtimeMs}\0${st.size}`;
    const hit = this.kept.get(key);
    if (hit) {
      // Most recently used last, so the oldest goes first.
      this.kept.delete(key);
      this.kept.set(key, hit);
      return hit.view;
    }
    const running = this.pending.get(key);
    if (running) return running;
    const work = this.convert(readFileSync(abs), format, extname(rel).slice(1).toLowerCase())
      .then((view) => {
        this.keep(key, view);
        return view;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, work);
    return work;
  }

  private async convert(bytes: Uint8Array, format: ViewFormat, ext: string): Promise<OfficeView> {
    if (TEXTUTIL_FORMATS.has(format)) {
      if (!this.host.textutil) throw new Error(`a .${ext} file is read by macOS's textutil, which this host does not have; download it to open it`);
      const html = await this.host.textutil(bytes, ext);
      return { ...(await this.host.run({ op: "sanitize", html, format })), notes: ["Read by macOS; pictures in the file are not shown."] };
    }
    if (PICTURE_FORMATS.has(format)) {
      const png = this.host.quickLook ? await this.host.quickLook(bytes, ext, PICTURE_EDGE) : undefined;
      if (!png) throw new Error(`a .${ext} file cannot be drawn on this host; download it to open it`);
      return { kind: "picture", format, src: `data:image/png;base64,${png.toString("base64")}`, notes: ["The first slide, as macOS draws it. Download the file for the rest."] };
    }
    return this.host.run({ op: "convert", bytes, format });
  }

  private keep(key: string, view: OfficeView): void {
    const size = JSON.stringify(view).length;
    if (size > CACHE_MAX / 4) return;
    this.kept.set(key, { view, size });
    this.keptSize += size;
    for (const [old, entry] of this.kept) {
      if (this.keptSize <= CACHE_MAX) break;
      this.kept.delete(old);
      this.keptSize -= entry.size;
    }
  }
}
