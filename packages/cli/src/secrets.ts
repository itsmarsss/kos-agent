import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

import type { KosClient } from "@kos/client";
import { applyEnvMove, isContained, planEnvMove, SECRET_FIELDS, SECRET_KINDS, SECRET_REQUIRED, Vault, VaultError, Verifiers, type EnvMove, type SecretFieldName, type SecretKind, type SecretValues, type VaultStatus } from "@kos/harness";

import { envFilePath } from "./env.js";

/**
 * `kos secrets`: the vault from a terminal (docs/secrets.md, CLI).
 *
 * The file is the vault, so these work whether or not the host runs, and
 * the host follows a change made here the next time it reads. A value is
 * never taken from the command line, where the shell's history and every
 * process listing would keep it: it is typed at a prompt that does not echo,
 * or piped on stdin.
 */

export const SECRETS_USAGE = [
  "usage: kos secrets <command>",
  "  init [--passphrase]          make the vault: a key file, or a passphrase alone, locked after each start",
  "  status                       whether it is there, locked or ready, and the host's view",
  "  unlock                       give the running host the passphrase",
  "  list                         handles, kinds, labels and hints; never a value",
  "  add <kind> <label> [--hosts a,b] [--origins https://x,https://y]",
  "                               kind: login | card | apikey | note; values asked, or piped on stdin",
  "  rm <handle> [--yes]          delete it, then rotate the data key",
  "  rotate [--passphrase | --no-passphrase | --key]",
  "                               a new data key; or set a passphrase (its slot alone, the key file erased);",
  "                               or take it off (back to a key file); or a new key file",
  "  export <file>                a copy only the passphrase opens",
  "  trust-seq [--yes]            take the vault on disk as the latest when both sequence records are gone",
  "  wipe [--yes]                 crypto-erase the vault and its key (a passphrase vault asks for it)",
  "  migrate-env [--dry-run] [--yes]",
  "                               move the keys KOS runs on out of .env: provider and channel keys into",
  "                               the vault, the hook secret into a check; their values blanked in .env",
].join("\n");

/** The fields a terminal asks for without echo: the ones that are secret on their own. */
const HIDDEN: ReadonlySet<SecretFieldName> = new Set(["password", "token", "number", "cvc", "text"]);

export interface SecretsCli {
  vault?: Vault;
  /** The running host, when there is one. */
  live?: () => Promise<KosClient | undefined>;
  /** What the user types, or what stdin holds. */
  ask?: (question: string, hidden: boolean) => Promise<string>;
  stdin?: () => Promise<string | undefined>;
  out?: (line: string) => void;
  /** The workspace, which the vault's folder must not be inside. */
  workspace?: string;
  /** The env file migrate-env reads, and the checks it keeps the hook secret as; the host's own by default. */
  envPath?: string;
  verifiers?: Verifiers;
  /** Into the workspace's audit log: a passphrase added or taken off is recorded as the dashboard records it. */
  audit?: (entry: { tool: string; args: Record<string, unknown>; result: string; isError: boolean }) => void;
}

/** A prompt that does not echo what is typed. */
async function prompt(question: string, hidden: boolean): Promise<string> {
  if (!process.stdin.isTTY) throw new VaultError("invalid", "no terminal to ask on: pipe the value on stdin");
  if (!hidden) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  }
  // The question shown, then what is typed read into a stream that writes nothing.
  process.stdout.write(question);
  const rl = createInterface({ input: process.stdin, output: new Writable({ write: (_chunk, _enc, done) => done() }), terminal: true });
  try {
    return await rl.question("");
  } finally {
    rl.close();
    process.stdout.write("\n");
  }
}

/** What was piped in, or undefined at a terminal. */
async function piped(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const list = (value: string | boolean | undefined): string[] => (typeof value === "string" ? value.split(",").map((v) => v.trim()).filter(Boolean) : []);

export async function runSecrets(rest: string[], flags: Record<string, string | boolean>, cli: SecretsCli = {}): Promise<number> {
  const vault = cli.vault ?? Vault.fromEnv(process.env, isContained(), cli.workspace);
  const ask = cli.ask ?? prompt;
  const out = cli.out ?? ((line: string) => console.log(line));
  const stdin = cli.stdin ?? piped;

  /** A new passphrase, typed twice. */
  const newPassphrase = async (): Promise<string> => {
    const first = await ask("New passphrase: ", true);
    if ((await ask("Again: ", true)) !== first) throw new VaultError("invalid", "the two passphrases differ");
    return first;
  };

  /** The vault open for a change: a passphrase vault asks for it here. */
  const open = async (): Promise<void> => {
    const { state } = vault.status();
    if (state === "locked" && vault.hasPassphrase()) await vault.unlock(await ask("Vault passphrase: ", true));
  };

  const confirmed = async (what: string, word: string): Promise<boolean> => flags.yes === true || (await ask(`${what} Type ${word} to go on: `, false)).trim() === word;

  /** migrate-env: list what would move, confirm, move it, blank it in .env. Run again, nothing moves. */
  const migrateEnv = async (): Promise<number> => {
    const path = cli.envPath ?? envFilePath();
    if (!existsSync(path)) throw new VaultError("invalid", `there is no env file at ${path}`);
    if (vault.status().state === "absent") throw new VaultError("absent", "there is no vault to move keys into: kos secrets init --passphrase, or Settings, Secrets");
    await open();
    const verifiers = cli.verifiers ?? new Verifiers(join(homedir(), ".kos"));
    const moves = planEnvMove(readFileSync(path, "utf8"), vault, verifiers);
    if (moves.length === 0) {
      out(`nothing in ${path} to move`);
      return 0;
    }
    out(`From ${path}:`);
    for (const move of moves) out(`  ${moveWords(move)}`);
    if (flags["dry-run"] === true) return 0;
    if (!moves.some((m) => m.state !== "differs")) return 1;
    if (!(await confirmed("Their values are blanked in .env; the names stay, commented.", "move"))) return 1;
    const done = applyEnvMove(path, moves, vault, verifiers);
    cli.audit?.({ tool: "secrets.migrate-env", args: { from: "cli", moved: done.flatMap((m) => m.envs) }, result: `${done.length} moved out of .env`, isError: false });
    out(`moved ${done.length}. Restart KOS (kos restart): the running host still holds them from .env, which wins until it starts again.`);
    return 0;
  };

  try {
    switch (rest[0]) {
      case "init": {
        await vault.init(flags.passphrase === true ? { passphrase: await newPassphrase() } : {});
        out(`vault made in ${vault.dir} (${vault.status().slots.join(" and ")})`);
        return 0;
      }
      case "status": {
        const s = vault.status();
        out(`vault: ${s.state}${s.slots.length ? ` (${s.slots.join(", ")})` : ""}${s.problem ? `: ${s.problem}` : ""}`);
        for (const device of s.devices ?? []) out(`  opens at login on ${device.name} (KOS for Mac)`);
        const client = await cli.live?.();
        if (client) {
          const host = await client.get<VaultStatus>("/api/secrets/status");
          out(`host: ${host.state}, ${host.scrubbed} masked since it started`);
        }
        return 0;
      }
      case "unlock": {
        const client = await cli.live?.();
        if (!client) throw new VaultError("invalid", "no host is running: the vault unlocks for the host that holds it (kos start)");
        const s = await client.post<VaultStatus>("/api/secrets/unlock", { passphrase: await ask("Vault passphrase: ", true) });
        out(`host: ${s.state}`);
        return 0;
      }
      case "list": {
        await open();
        const all = vault.list();
        if (all.length === 0) out("no secrets in the vault");
        for (const s of all) out(`${s.handle}  ${s.kind}  ${s.label}  ${s.hint}  [${s.fields.join(", ")}]`);
        return 0;
      }
      case "add": {
        const [, kind, ...words] = rest;
        const label = words.join(" ");
        if (!kind || !(SECRET_KINDS as readonly string[]).includes(kind) || !label) throw new VaultError("invalid", SECRETS_USAGE);
        await open();
        const values = await valuesFor(kind as SecretKind, { ask, stdin });
        const use = { http: { hosts: list(flags.hosts) }, web: { origins: list(flags.origins), frames: [] } };
        out(`added ${vault.add({ label, kind: kind as SecretKind, values, use })}`);
        return 0;
      }
      case "rm": {
        const handle = rest[1];
        if (!handle) throw new VaultError("invalid", SECRETS_USAGE);
        await open();
        if (!vault.get(handle)) throw new VaultError("not-found", `there is no secret ${handle}`);
        if (!(await confirmed(`Delete ${handle}?`, handle))) return 1;
        vault.remove(handle);
        out(`deleted ${handle}; the data key was rotated`);
        return 0;
      }
      case "rotate": {
        await open();
        if (flags.passphrase === true) {
          const had = vault.hasPassphrase();
          await vault.setPassphrase(await newPassphrase());
          cli.audit?.({ tool: "secrets.passphrase", args: { change: had ? "change" : "add", from: "cli" }, result: "passphrase set, key file erased", isError: false });
          out("passphrase set, and the key file erased: the vault opens with it, or with KOS for Mac where unlock at login is on");
        } else if (flags["no-passphrase"] === true) {
          vault.removePassphrase();
          cli.audit?.({ tool: "secrets.passphrase", args: { change: "remove", from: "cli" }, result: "key-file slot only", isError: false });
          out("passphrase taken off: the vault opens with its key file again");
        } else if (flags.key === true) {
          vault.rotateKeyfile();
          cli.audit?.({ tool: "secrets.rotate", args: { what: "key file", from: "cli" }, result: "rotated", isError: false });
          out("new key file written; the vault opens with it");
        } else {
          vault.rotateDataKey();
          cli.audit?.({ tool: "secrets.rotate", args: { what: "data key", from: "cli" }, result: "rotated", isError: false });
          out("data key rotated: every entry sealed again, every slot wrapped again");
        }
        return 0;
      }
      case "export": {
        const file = rest[1];
        if (!file) throw new VaultError("invalid", SECRETS_USAGE);
        await open();
        const passphrase = vault.hasPassphrase() ? await ask("Vault passphrase: ", true) : await newPassphrase();
        await vault.exportTo(file, passphrase);
        out(`exported to ${file}; only the passphrase opens it`);
        return 0;
      }
      case "trust-seq": {
        if (vault.status().state === "absent") throw new VaultError("absent", "there is no vault");
        if (!(await confirmed("This takes the vault file on disk as the latest, though nothing records its sequence. Only do this if you did not put an older copy back.", "trust"))) return 1;
        await vault.trustSeq(vault.hasPassphrase() ? await ask("Vault passphrase: ", true) : undefined);
        cli.audit?.({ tool: "secrets.trust-seq", args: { from: "cli" }, result: "sequence records written again", isError: false });
        const s = vault.status();
        out(`vault: ${s.state}${s.problem ? `: ${s.problem}` : ""}`);
        return 0;
      }
      case "wipe": {
        if (vault.status().state === "absent") throw new VaultError("absent", "there is no vault to wipe");
        if (!(await confirmed("This erases every secret for good.", "wipe"))) return 1;
        await vault.wipe(vault.hasPassphrase() ? await ask("Vault passphrase: ", true) : undefined);
        cli.audit?.({ tool: "secrets.wipe", args: { from: "cli" }, result: "wiped", isError: false });
        out("vault wiped");
        return 0;
      }
      case "migrate-env":
        return await migrateEnv();
      default:
        out(SECRETS_USAGE);
        return rest[0] === undefined || rest[0] === "help" ? 0 : 1;
    }
  } catch (err) {
    if (err instanceof VaultError || (err instanceof Error && err.name === "RecordError")) {
      out(err.message);
      return 1;
    }
    throw err;
  }
}

/**
 * A kind's values: piped on stdin (a JSON object of fields, or the main
 * field alone), or asked one field at a time, the secret ones without echo.
 */
async function valuesFor(kind: SecretKind, io: { ask: (q: string, hidden: boolean) => Promise<string>; stdin: () => Promise<string | undefined> }): Promise<SecretValues> {
  const fields = SECRET_FIELDS[kind].filter((f) => f !== "billing");
  const given = await io.stdin();
  if (given !== undefined) {
    const text = given.replace(/\r?\n$/, "");
    if (text.trimStart().startsWith("{")) return JSON.parse(text) as SecretValues;
    return { [fields[0]!]: text } as SecretValues;
  }
  const values: Record<string, string> = {};
  for (const field of fields) {
    const required = SECRET_REQUIRED[kind].includes(field);
    const value = await io.ask(`${field}${required ? "" : " (optional)"}: `, HIDDEN.has(field));
    if (value) values[field] = value;
  }
  return values as SecretValues;
}

/** One planned move, as the list before the confirm says it. */
function moveWords(move: EnvMove): string {
  const names = move.envs.join(", ");
  const to = "verifier" in move.to ? "a check in ~/.kos: KOS keeps no copy, so keep yours" : `the vault, as KOS's ${move.to.harness} key`;
  if (move.state === "differs") return `${names}: ${"verifier" in move.to ? "a check of another value is kept" : `the vault's ${move.to.harness} key holds another value`}; left as it is`;
  return `${names} -> ${to}${move.state === "kept" ? " (already there; only blanked in .env)" : ""}`;
}
