import { useState } from "react";

import { api, type Attachment } from "../api.js";
import { readFile } from "../Attachments.js";
import { joinPath, nameOf, parentOf, within } from "./model.js";

/**
 * What the owner does to files by hand, each through the server's jailed
 * routes: rename, a new folder, duplicate, move, the trash and back,
 * upload, download, copy a path. Each tells the view what changed so it
 * reads the folders again, and says what went wrong in words.
 */

/** The most one file may be, as the server takes it (FILE_MAX_BYTES). */
export const UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

/** A word on what just happened, with a way back when there is one. */
export interface Notice {
  text: string;
  tone: "ok" | "err";
  undo?: () => void;
}

export interface FinderOps {
  rename: (path: string, name: string) => Promise<string | undefined>;
  newFolder: (dir: string, name: string) => Promise<string | undefined>;
  duplicate: (paths: string[]) => Promise<string[]>;
  move: (paths: string[], dir: string) => Promise<void>;
  trash: (paths: string[]) => Promise<void>;
  upload: (files: File[], dir: string) => Promise<void>;
  download: (paths: string[]) => void;
  copyPath: (paths: string[]) => void;
  /** How far through a batch of uploads, while one runs. */
  uploading: { done: number; total: number } | null;
  notice: Notice | null;
  /** Say what was done elsewhere (the trash's Restore), as the notice every op uses. */
  say: (text: string) => void;
  dismiss: () => void;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function useFinderOps({ onChanged, send = (file, dir) => api.uploadFile(dir === "." ? "" : dir, file) }: { onChanged: () => void; send?: (file: Attachment, dir: string) => Promise<unknown> }): FinderOps {
  const [notice, setNotice] = useState<Notice | null>(null);
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null);
  const fail = (err: unknown): void => setNotice({ text: message(err), tone: "err" });
  const say = (text: string, undo?: () => void): void => setNotice({ text, tone: "ok", ...(undo ? { undo } : {}) });

  /** Each path in turn; what failed is said once, by name. */
  const each = async <T,>(paths: string[], work: (path: string) => Promise<T>): Promise<T[]> => {
    const done: T[] = [];
    const failed: string[] = [];
    for (const path of paths) {
      try {
        done.push(await work(path));
      } catch (err) {
        failed.push(`${nameOf(path)}: ${message(err)}`);
      }
    }
    onChanged();
    if (failed.length) setNotice({ text: failed.join(" · "), tone: "err" });
    return done;
  };

  return {
    rename: async (path, name) => {
      const clean = name.trim();
      if (!clean || clean === nameOf(path)) return undefined;
      if (clean.includes("/")) {
        fail(new Error("a name cannot hold a slash"));
        return undefined;
      }
      try {
        const done = await api.renameFile(path, joinPath(parentOf(path), clean));
        onChanged();
        say(`Renamed to ${clean}`, () => {
          void each([done.path], (p) => api.renameFile(p, path)).then((back) => back.length && setNotice(null));
        });
        return done.path;
      } catch (err) {
        fail(err);
        return undefined;
      }
    },
    newFolder: async (dir, name) => {
      try {
        const made = await api.makeDir(joinPath(dir, name));
        onChanged();
        return made.path;
      } catch (err) {
        fail(err);
        return undefined;
      }
    },
    duplicate: (paths) => each(paths, async (p) => (await api.copyFile(p)).path),
    move: async (paths, dir) => {
      // Not into itself, and not where it already is.
      const moving = paths.filter((p) => !within(dir, p) && parentOf(p) !== dir);
      if (!moving.length) return;
      const moved = await each(moving, async (p) => ({ from: p, to: (await api.renameFile(p, joinPath(dir, nameOf(p)))).path }));
      if (!moved.length) return;
      say(`Moved ${moved.length === 1 ? nameOf(moved[0]!.from) : `${moved.length} items`} to ${dir === "." ? "the workspace" : nameOf(dir)}`, () => {
        const back = new Map(moved.map((m) => [m.to, m.from]));
        void each([...back.keys()], (to) => api.renameFile(to, back.get(to)!)).then((done) => done.length === moved.length && setNotice(null));
      });
    },
    trash: async (paths) => {
      const items = await each(paths, (p) => api.trashFile(p));
      if (!items.length) return;
      say(`Moved ${items.length === 1 ? items[0]!.name : `${items.length} items`} to the Trash`, () => {
        // Only a full put-back clears the word; a failure's own words stay.
        void each(items.map((i) => i.id), (id) => api.restoreFile(id)).then((back) => back.length === items.length && setNotice(null));
      });
    },
    upload: async (files, dir) => {
      const tooBig = files.filter((f) => f.size > UPLOAD_MAX_BYTES);
      const fits = files.filter((f) => f.size <= UPLOAD_MAX_BYTES);
      const failed = tooBig.map((f) => `${f.name}: over the ${UPLOAD_MAX_BYTES / 1024 / 1024} MB a file can be`);
      setUploading({ done: 0, total: fits.length });
      for (const [i, f] of fits.entries()) {
        try {
          await send(await readFile(f), dir);
        } catch (err) {
          failed.push(`${f.name}: ${message(err)}`);
        }
        setUploading({ done: i + 1, total: fits.length });
      }
      setUploading(null);
      onChanged();
      if (failed.length) setNotice({ text: failed.join(" · "), tone: "err" });
      else if (fits.length) say(`Uploaded ${fits.length === 1 ? fits[0]!.name : `${fits.length} files`}`);
    },
    download: (paths) => {
      for (const p of paths) void api.downloadFile(p).catch(fail);
    },
    copyPath: (paths) => {
      void navigator.clipboard
        .writeText(paths.join("\n"))
        .then(() => say(paths.length === 1 ? "Copied the path" : `Copied ${paths.length} paths`))
        .catch(fail);
    },
    uploading,
    notice,
    say: (text) => say(text),
    dismiss: () => setNotice(null),
  };
}
