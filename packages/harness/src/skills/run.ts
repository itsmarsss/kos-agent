import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { RESERVED } from "../kernel/files.js";
import { childEnv } from "../sandbox/env.js";
import { GIT_CONTROL_WRITES, gitGlobalConfig } from "../sandbox/githold.js";
import { nodeReads, runJailedNode, type SandboxResult, type SkillJail } from "../sandbox/runner.js";
import { resolvePath } from "../jail/resolvePath.js";
import { DB_FILENAME } from "../store/workspace.js";

/** KOS's own state and settings a promoted skill may read but not write: all of RESERVED but the database it runs against. */
const KEPT = [...RESERVED].filter((name) => !name.startsWith(DB_FILENAME));

/**
 * Run a promoted skill for real: against the live database with effects
 * unmocked, and still jailed. It writes the workspace and the database
 * and nothing else: not KOS's own settings or state, not a repository's
 * config or hooks, not the git config every child reads; it reads none of
 * the owner's home, a .env or KOS's keys, and never reaches KOS's own
 * ports. The network is open, as the owner's yes to the code was a yes to
 * what it does. With no jail on this machine it is refused.
 *
 * It runs unasked only on that yes, to the files as they were (see
 * skillHash): the most dangerous thing KOS does, which is why the jail
 * holds even then.
 */
export async function runSkillLive(options: {
  workspaceRoot: string;
  entry: string;
  args?: string[];
  timeoutMs?: number;
  jail?: SkillJail;
}): Promise<SandboxResult> {
  const root = options.workspaceRoot;
  const entryAbs = resolvePath(root, options.entry);
  const liveDb = resolvePath(root, DB_FILENAME);
  const tmp = join(root, ".kos", "tmp");
  mkdirSync(tmp, { recursive: true });
  return runJailedNode(entryAbs, options.args ?? [], {
    cwd: root,
    // An allow-list, not the host's environment: see childEnv. A promoted
    // skill runs against the live database, which is all the more reason it
    // should not also be handed the owner's credentials.
    env: childEnv({ home: root, tmp }, { KOS_DB: liveDb }),
    timeoutMs: options.timeoutMs ?? 30_000,
    jail: {
      workspaceRoot: root,
      hidden: [join(root, ".env")],
      readOnly: [...KEPT.map((name) => join(root, name)), join(root, ".env"), ...gitGlobalConfig(root)],
      writableWithin: [tmp],
      unwritable: GIT_CONTROL_WRITES,
      reads: nodeReads(),
      ...options.jail,
    },
  });
}
