import { delimiter } from "node:path";

/**
 * The environment a spawned skill is given.
 *
 * Secrets are kept in the process environment precisely because the jail stops
 * the agent reading files outside the workspace. Handing a child
 * `...process.env` gave that reasoning away: agent-written code could print
 * OPENAI_API_KEY, the Discord token, and every unrelated credential the host
 * happened to be carrying. A child gets what it needs by name instead, so a
 * new secret in the owner's shell is not a new thing the agent can read.
 *
 * This is a perimeter around what a child can *see*, not what it can *do*. A
 * spawned process still runs with the host account's authority; only the
 * container jail bounds that.
 */

/**
 * Variables that carry no secret and that tooling genuinely breaks without.
 * Locale and timezone matter because a skill that formats a date should agree
 * with the rest of the system about what day it is.
 */
const PASS_THROUGH = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  // Windows will not start a process without these.
  "SystemRoot",
  "COMSPEC",
  "PATHEXT",
];

export interface ChildEnvOptions {
  /**
   * What the child should treat as its home directory. Pointed at the
   * workspace rather than the owner's, so tools that scatter caches and
   * configs into $HOME do it somewhere the agent is allowed to be.
   */
  home: string;
  /** Scratch space, likewise kept away from the owner's own temp files. */
  tmp?: string;
}

/** Build the environment for a child process: an allow-list, plus what it is told. */
export function childEnv(
  options: ChildEnvOptions,
  extra: Record<string, string> = {},
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASS_THROUGH) {
    const value = source[key];
    if (value) env[key] = value;
  }
  // A PATH is not optional; without one, spawning anything that is not an
  // absolute path fails in a way that reads as the skill being broken.
  if (!env.PATH) env.PATH = ["/usr/local/bin", "/usr/bin", "/bin"].join(delimiter);

  env.HOME = options.home;
  env.USERPROFILE = options.home;
  if (options.tmp) {
    env.TMPDIR = options.tmp;
    env.TEMP = options.tmp;
    env.TMP = options.tmp;
  }

  return { ...env, ...extra };
}
