import { primarySessionId } from "@kos/harness";

import type { KosClient } from "./client.js";

/**
 * Run offline-style CLI commands against a live kos host (no local Kernel).
 */
export async function runRemoteCommand(
  client: KosClient,
  command: string,
  rest: string[],
): Promise<string> {
  switch (command) {
    case "help":
      return REMOTE_HELP;

    case "status": {
      const s = await client.status();
      return [
        `host: live (pid ${s.pid ?? "?"})`,
        `discord: ${s.discord ? "on" : "off"}`,
        `kill switch: ${s.halted ? "HALTED" : "running"}`,
        `queue depth: ${s.queueDepth}`,
        `crons: ${s.crons}`,
        `pending approvals: ${s.pendingApprovals}`,
        `projects: ${s.projects}`,
        `pages: ${s.pages}`,
        s.workspace ? `workspace: ${s.workspace}` : "",
      ]
        .filter(Boolean)
        .join(" | ");
    }

    case "approvals": {
      const pending = await client.approvals();
      if (pending.length === 0) return "no pending approvals";
      return pending
        .map((p) => `#${p.id} ${p.tool} ${p.args} (${p.reason ?? ""})`)
        .join("\n");
    }

    case "approve": {
      const id = Number(rest[0]);
      if (!Number.isInteger(id)) return "usage: approve <id>";
      const res = await client.approve(id);
      return res.message;
    }

    case "deny": {
      const id = Number(rest[0]);
      if (!Number.isInteger(id)) return "usage: deny <id>";
      return (await client.deny(id)).message;
    }

    case "halt":
      await client.setKill(true);
      return "kill switch engaged; crons and self-prompts halted";

    case "resume":
      await client.setKill(false);
      return "kill switch released";

    case "crons": {
      const jobs = await client.crons();
      if (jobs.length === 0) return "no scheduled jobs";
      return jobs
        .map(
          (j) =>
            `#${j.id} ${j.name} [${j.schedule}] ${j.type}${j.enabled ? "" : " (disabled)"}`,
        )
        .join("\n");
    }

    case "snapshot": {
      const res = await client.snapshot(rest.join(" ") || undefined);
      return res.sha ? `snapshot ${res.sha.slice(0, 10)}` : "nothing to snapshot";
    }

    case "clear": {
      const sessionId = rest[0] ?? primarySessionId();
      const res = await client.clear(sessionId);
      return `cleared session ${res.cleared}`;
    }

    case "memory": {
      const { facts } = await client.memory();
      if (facts.length === 0) return "no durable facts yet";
      return facts.map((f) => `(${f.kind}) ${f.key}: ${f.value}`).join("\n");
    }

    case "pages": {
      const list = await client.pages();
      if (list.length === 0) return "no pages";
      return list
        .map((p) => `${p.id} [${p.projectSlug}] ${p.title}`)
        .join("\n");
    }

    default:
      return `unknown command: ${command}\n${REMOTE_HELP}`;
  }
}

const REMOTE_HELP = `kos (attached to host):
  chat                 REPL through the host (default)
  once <message>       one message through the host
  status | approvals | approve | deny | halt | resume
  crons | snapshot | clear | memory | pages
  stop                 stop the background host
  help

Host must be running (kos start). Discord DMs share the same session.`;
