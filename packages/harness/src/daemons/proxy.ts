import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";

import type { DaemonStore } from "./store.js";
import type { DaemonSupervisor } from "./supervisor.js";

/**
 * Reaching a daemon from the dashboard.
 *
 * A daemon listens on loopback on a port KOS assigned it, and nothing outside
 * this machine can reach it. That is the point: the way in is through the
 * dashboard, which already has the owner's authentication in front of it, so a
 * daemon does not have to grow its own.
 *
 * `/apps/<project>/<name>/rest/of/path` becomes a request to
 * `127.0.0.1:<port>/rest/of/path`.
 */

const PREFIX = "/apps/";

export interface ProxyTarget {
  port: number;
  /** The path as the daemon sees it, always starting with a slash. */
  path: string;
}

/**
 * Work out which daemon a URL is for, and what to ask it.
 *
 * Returns nothing when the path is not a daemon's, which is the ordinary case
 * for every other request the server handles.
 */
export function routeTo(
  url: string,
  lookup: (project: string, name: string) => { port: number | null } | undefined,
): ProxyTarget | undefined {
  if (!url.startsWith(PREFIX)) return undefined;
  const [pathPart, query] = url.slice(PREFIX.length).split("?", 2);
  const segments = (pathPart ?? "").split("/");
  const project = segments[0];
  const name = segments[1];
  if (!project || !name) return undefined;

  const daemon = lookup(project, name);
  if (!daemon || daemon.port === null) return undefined;

  const rest = segments.slice(2).join("/");
  return {
    port: daemon.port,
    path: `/${rest}${query ? `?${query}` : ""}`,
  };
}

/**
 * Hand a request to a daemon and its answer back.
 *
 * Returns false when the URL is not a daemon's, so the caller carries on with
 * whatever it would have done. A daemon that is registered but not up answers
 * 502 rather than 404: "not running" and "no such app" are different problems
 * and lead to different next steps.
 */
export function proxyToDaemon(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { store: DaemonStore; supervisor: DaemonSupervisor },
): boolean {
  const url = req.url ?? "/";
  let daemonId: number | undefined;
  const target = routeTo(url, (project, name) => {
    const found = deps.store.find(project, name);
    daemonId = found?.id;
    return found;
  });
  if (!target) return false;

  if (daemonId !== undefined && !deps.supervisor.isRunning(daemonId)) {
    const status = deps.supervisor.statusOf(daemonId);
    res.writeHead(502, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: "that app is not running",
        state: status.state,
        ...(status.lastError ? { lastError: status.lastError } : {}),
      }),
    );
    return true;
  }

  const upstream = httpRequest(
    {
      host: "127.0.0.1",
      port: target.port,
      method: req.method,
      path: target.path,
      headers: { ...req.headers, host: `127.0.0.1:${target.port}` },
    },
    (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    },
  );

  upstream.on("error", (err: Error) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `that app did not answer: ${err.message}` }));
  });

  req.pipe(upstream);
  return true;
}
