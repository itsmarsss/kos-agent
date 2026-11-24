import { chmodSync, readFileSync, writeFileSync } from "node:fs";

import { parseEnvFile, WRITABLE_SECRETS } from "./envfile.js";
import { HARNESS_KEYS, harnessNameOf } from "./secrets.js";
import type { Vault } from "./vault.js";
import type { VerifierName, Verifiers } from "./verifiers.js";

/**
 * `kos secrets migrate-env` (docs/secrets.md, CLI): the keys KOS runs on
 * moved out of `.env`. Each provider or channel key becomes a vault API key
 * naming its harness name (`use.harness`); the hook secret becomes a check
 * (verifiers.ts). The values are blanked in `.env`, their names kept as a
 * comment saying where they went. Run twice, it moves nothing the second
 * time; cut short between the two writes, the next run finds the vault
 * already holding the same value and only blanks `.env`.
 *
 * The dashboard token stays: the kos CLI sends it and it signs links, so
 * KOS needs the value itself.
 */

export interface EnvMove {
  /** The env names it is under, the one read first first. */
  envs: string[];
  /** Where it goes: a vault key by harness name, or a check. */
  to: { harness: string } | { verifier: VerifierName };
  /** `move`: written then blanked; `kept`: already there with this value, only blanked; `differs`: another value is there, left alone. */
  state: "move" | "kept" | "differs";
}

const VERIFIED: Readonly<Record<string, VerifierName>> = { KOS_HOOK_SECRET: "hook" };

/** What the env file holds that would move, and what each would do. */
export function planEnvMove(text: string, vault: Vault, verifiers: Verifiers): EnvMove[] {
  const env = parseEnvFile(text);
  const named = new Map<string, string[]>();
  for (const [key, value] of Object.entries(env)) {
    const name = value.trim() ? harnessNameOf(key) : undefined;
    if (name) named.set(name, [...(named.get(name) ?? []), key]);
  }
  const moves: EnvMove[] = [];
  for (const [name, keys] of named) {
    // The name the registry reads first is the value that is live now.
    const order = HARNESS_KEYS[name] ?? keys;
    const envs = [...keys].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const value = env[envs[0]!]!.trim();
    const held = vault.harness(name);
    const state = !held ? "move" : vault.value(held.handle, "token") === value ? "kept" : "differs";
    moves.push({ envs, to: { harness: name }, state });
  }
  for (const [key, verifier] of Object.entries(VERIFIED)) {
    const value = env[key]?.trim();
    if (!value) continue;
    const state = !verifiers.has(verifier) ? "move" : verifiers.matches(verifier, value) ? "kept" : "differs";
    moves.push({ envs: [key], to: { verifier }, state });
  }
  return moves;
}

/** The moves made: vault keys and checks written, then their values blanked in the env file. */
export function applyEnvMove(path: string, moves: readonly EnvMove[], vault: Vault, verifiers: Verifiers): EnvMove[] {
  const text = readFileSync(path, "utf8");
  const env = parseEnvFile(text);
  const done = moves.filter((m) => m.state !== "differs");
  for (const move of done) {
    if (move.state !== "move") continue;
    const value = env[move.envs[0]!]!.trim();
    if ("verifier" in move.to) {
      verifiers.set(move.to.verifier, value);
      continue;
    }
    const label = WRITABLE_SECRETS[move.envs[0]!]?.label ?? move.envs[0]!;
    vault.add({ label: `${label} (from .env)`, kind: "apikey", values: { token: value }, use: { harness: move.to.harness } });
  }
  const blanked = new Map(done.flatMap((m) => m.envs.map((e) => [e, "verifier" in m.to ? "kept as a check in ~/.kos (Settings, Providers)" : `moved to the KOS vault as its ${m.to.harness} key (kos secrets list)`] as const)));
  const lines = text.split("\n").map((line) => {
    const key = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
    const where = key ? blanked.get(key) : undefined;
    return where ? `# ${key}= ${where}` : line;
  });
  writeFileSync(path, lines.join("\n"), { mode: 0o600 });
  chmodSync(path, 0o600);
  return done;
}
