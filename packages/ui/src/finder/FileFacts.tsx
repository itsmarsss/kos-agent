import { useEffect, useState, type ReactElement } from "react";

import { bytesWords } from "@kos/shared";

import { api, type FileInfo } from "../api.js";
import { FileIcon } from "../FileIcon.js";
import { Thumb } from "../FileThumb.js";
import { dateWords, kindOf } from "./model.js";

/**
 * One thing's picture and facts: kind, size, where, when it was made and
 * changed, its pixels or pages, and the project it belongs to. The Info
 * panel and the last column both show this.
 */

export function useFileInfo(path: string | null, version?: number): { info: FileInfo | null; error: string | null } {
  const [info, setInfo] = useState<FileInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setInfo(null);
    setError(null);
  }, [path]);
  useEffect(() => {
    if (!path) return undefined;
    let cancelled = false;
    void api
      .fileInfo(path)
      .then((i) => !cancelled && setInfo(i))
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [path, version]);
  return { info, error };
}

function where(path: string, rootName: string): string {
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  return parent ? `${rootName} › ${parent.split("/").join(" › ")}` : rootName;
}

export function FileFacts({ path, version, rootName = "Workspace", compact = false }: { path: string; version?: number; rootName?: string; compact?: boolean }): ReactElement {
  const { info, error } = useFileInfo(path, version);
  const name = path.split("/").pop() ?? path;
  const kind = info?.kind ?? "file";
  const facts: [string, string][] = info
    ? [
        ["Kind", kindOf(info)],
        ...(info.kind === "file" ? [["Size", `${bytesWords(info.size)}${info.size >= 1000 ? ` (${info.size.toLocaleString()} bytes)` : ""}`] as [string, string]] : []),
        ...(info.items !== undefined ? [["Items", String(info.items)] as [string, string]] : []),
        ...(info.width && info.height ? [["Dimensions", `${info.width} × ${info.height}`] as [string, string]] : []),
        ...(info.pages !== undefined ? [[info.pagesUnit === "slides" ? "Slides" : info.pagesUnit === "sheets" ? "Sheets" : "Pages", String(info.pages)] as [string, string]] : []),
        ["Where", where(info.path, rootName)],
        ...(info.project ? [["Project", info.project.name] as [string, string]] : []),
        ["Created", dateWords(info.createdAt)],
        ["Modified", dateWords(info.modifiedAt)],
      ]
    : [];
  return (
    <div className={`finder-facts${compact ? " finder-facts--compact" : ""}`}>
      <div className="finder-facts-art">
        {kind === "dir" ? (
          <span className="files-thumb">
            <FileIcon name={name} kind="dir" size={56} />
          </span>
        ) : (
          <Thumb path={path} name={name} edge={512} iconSize={56} {...(version !== undefined ? { version } : {})} />
        )}
      </div>
      <p className="finder-facts-name">{name}</p>
      {error && <p className="hint">{error}</p>}
      {info && (
        <dl className="finder-facts-list">
          {facts.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
