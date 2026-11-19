import { useCallback, useEffect, useState } from "react";

import type { SearchTarget } from "@kos/shared";

import { hrefFor, type Route } from "./routes.js";

/**
 * The query on a hash route, which is the page's own business: where in it
 * to land (`#/chats/<id>?at=12`, `#/files/<path>?line=40`). parseRoute
 * ignores it, so an address with one still names the same page, and the
 * page reads it, acts on it once and takes it back off.
 */

export function hashParam(hash: string, name: string): string | undefined {
  const at = hash.indexOf("?");
  if (at < 0) return undefined;
  return new URLSearchParams(hash.slice(at + 1)).get(name) ?? undefined;
}

/** A route's address with a query on it. */
export function withParams(href: string, params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString();
  return query ? `${href}?${query}` : href;
}

/**
 * One parameter of the address, kept current as the address changes, and
 * what takes it off once it is acted on.
 */
export function useHashParam(name: string): [string | undefined, () => void] {
  const [value, setValue] = useState(() => hashParam(window.location.hash, name));
  useEffect(() => {
    const read = (): void => setValue(hashParam(window.location.hash, name));
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, [name]);
  const clear = useCallback(() => {
    dropHashParam(name);
    setValue(undefined);
  }, [name]);
  return [value, clear];
}

/** The address without `name`, in place: acted on, it is not acted on again by Back or a reload. */
export function dropHashParam(name: string): void {
  const hash = window.location.hash;
  const at = hash.indexOf("?");
  if (at < 0) return;
  const params = new URLSearchParams(hash.slice(at + 1));
  if (!params.has(name)) return;
  params.delete(name);
  const rest = params.toString();
  history.replaceState(null, "", `${hash.slice(0, at)}${rest ? `?${rest}` : ""}`);
}

/**
 * Where a search hit opens, as an address: a chat at its message, a file at
 * its line, a claim, a memory page, a secret's sheet, a settings section.
 * A run and a tool call open as a record over Runs, which an address does
 * not name, so they have none.
 */
export function targetHref(target: SearchTarget, placeOf: (chat: string) => Route): string | undefined {
  switch (target.kind) {
    case "chat":
      return withParams(hrefFor(placeOf(target.id)), { at: String(target.event) });
    case "file":
      return withParams(hrefFor({ name: "files", path: target.path }), { line: String(target.line) });
    case "claim":
      return withParams(hrefFor({ name: "memory" }), { tab: "claims", ids: String(target.id) });
    case "memory-page":
      return withParams(hrefFor({ name: "memory" }), { tab: "pages", page: target.name });
    case "secret":
      return withParams(hrefFor({ name: "secrets" }), { open: target.handle });
    case "settings":
      return hrefFor({ name: "settings", section: target.section });
    case "run":
    case "call":
      return undefined;
  }
}
