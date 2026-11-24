import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SecretsRegistry, Vault, Verifiers } from "@kos/harness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runSecrets, type SecretsCli } from "./secrets.js";

let root: string;
let lines: string[];
let asked: { question: string; hidden: boolean }[];

/** The CLI with a scripted terminal: each answer in turn, and stdin as given. */
function cli(answers: string[] = [], stdin?: string): SecretsCli {
  return {
    vault: new Vault({ dir: join(root, "secrets") }),
    ask: async (question, hidden) => {
      asked.push({ question, hidden });
      return answers.shift() ?? "";
    },
    stdin: async () => stdin,
    out: (line) => lines.push(line),
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kos-cli-secrets-"));
  lines = [];
  asked = [];
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("kos secrets", () => {
  it("inits, adds from hidden prompts, lists without values", async () => {
    expect(await runSecrets(["init"], {}, cli())).toBe(0);
    expect(await runSecrets(["add", "login", "GitHub", "work"], { origins: "https://github.com" }, cli(["pw-cli-canary-1", "owner"]))).toBe(0);
    expect(asked).toEqual([
      { question: "password: ", hidden: true },
      { question: "username (optional): ", hidden: false },
    ]);
    lines = [];
    await runSecrets(["list"], {}, cli());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^github-work-[a-z0-9]{4}  login  GitHub work  ••••••••  \[password, username\]$/);
    expect(lines.join("")).not.toContain("pw-cli-canary-1");
  });

  it("takes a value piped on stdin, never from argv", async () => {
    await runSecrets(["init"], {}, cli());
    await runSecrets(["add", "apikey", "Stripe"], { hosts: "api.stripe.com" }, cli([], "sk_live_piped_0123456789\n"));
    await runSecrets(["add", "card", "Visa"], {}, cli([], JSON.stringify({ number: "4242 4242 4242 4242", cvc: "123" })));
    const vault = new Vault({ dir: join(root, "secrets") });
    const [stripe, visa] = vault.list();
    expect(vault.value(stripe!.handle, "token")).toBe("sk_live_piped_0123456789");
    expect(stripe!.use.http.hosts).toEqual(["api.stripe.com"]);
    expect(visa!.hint).toBe("•••• 4242");
    expect(asked).toEqual([]);
  });

  it("asks a passphrase vault's passphrase before a change, and rotates, exports, removes and wipes", async () => {
    await runSecrets(["init"], { passphrase: true }, cli(["a long passphrase", "a long passphrase"]));
    expect(await runSecrets(["add", "note", "Recovery"], {}, cli(["a long passphrase", "the words of the phrase"]))).toBe(0);
    expect(asked.map((a) => a.hidden)).toEqual([true, true, true, true]);
    await runSecrets(["rotate"], {}, cli(["a long passphrase"]));
    const out = join(root, "copy.kosv");
    await runSecrets(["export", out], {}, cli(["a long passphrase", "a long passphrase"]));
    expect(JSON.parse(readFileSync(out, "utf8")).slots.map((s: { kind: string }) => s.kind)).toEqual(["passphrase"]);
    const handle = new Vault({ dir: join(root, "secrets") });
    await handle.unlock("a long passphrase");
    const [note] = handle.list();
    expect(await runSecrets(["rm", note!.handle], {}, cli(["a long passphrase", "not it"]))).toBe(1);
    expect(await runSecrets(["rm", note!.handle], { yes: true }, cli(["a long passphrase"]))).toBe(0);
    expect(await runSecrets(["wipe"], {}, cli(["wipe", "not the passphrase"]))).toBe(1);
    expect(await runSecrets(["wipe"], {}, cli(["wipe", "a long passphrase"]))).toBe(0);
    expect(existsSync(join(root, "secrets", "vault.kosv"))).toBe(false);
  }, 30_000);

  it("sets a passphrase as the only key, erasing the key file, and takes it off, audited", async () => {
    const audits: string[] = [];
    const io = (answers: string[]): SecretsCli => ({ ...cli(answers), audit: (e) => audits.push(`${e.tool} ${String(e.args.change)}`) });
    await runSecrets(["init"], {}, io([]));
    expect(existsSync(join(root, "secrets", "key"))).toBe(true);
    expect(await runSecrets(["rotate"], { passphrase: true }, io(["a long passphrase", "a long passphrase"]))).toBe(0);
    expect(existsSync(join(root, "secrets", "key"))).toBe(false);
    expect(new Vault({ dir: join(root, "secrets") }).status()).toMatchObject({ state: "locked", slots: ["passphrase"] });
    expect(await runSecrets(["rotate"], { "no-passphrase": true }, io(["a long passphrase"]))).toBe(0);
    expect(new Vault({ dir: join(root, "secrets") }).status()).toMatchObject({ state: "ready", slots: ["keyfile"] });
    expect(audits).toEqual(["secrets.passphrase add", "secrets.passphrase remove"]);
  }, 30_000);

  it("trusts the vault on disk once both sequence records are gone, after the owner confirms", async () => {
    await runSecrets(["init"], {}, cli());
    await runSecrets(["add", "note", "N"], {}, cli([], "some note text here"));
    rmSync(join(root, "secrets", "seq"));
    rmSync(join(root, "secrets.seq"));
    expect(new Vault({ dir: join(root, "secrets") }).status().state).toBe("locked");
    const audits: string[] = [];
    const io = (answers: string[]): SecretsCli => ({ ...cli(answers), audit: (e) => audits.push(e.tool) });
    expect(await runSecrets(["trust-seq"], {}, io(["no"]))).toBe(1);
    expect(await runSecrets(["trust-seq"], {}, io(["trust"]))).toBe(0);
    expect(lines.at(-1)).toBe("vault: ready");
    await runSecrets(["rotate"], {}, io([]));
    await runSecrets(["rotate"], { key: true }, io([]));
    await runSecrets(["wipe"], { yes: true }, io([]));
    expect(audits).toEqual(["secrets.trust-seq", "secrets.rotate", "secrets.rotate", "secrets.wipe"]);
  });

  it("says why a command cannot run", async () => {
    expect(await runSecrets(["unlock"], {}, cli())).toBe(1);
    expect(lines.at(-1)).toMatch(/no host is running/);
    expect(await runSecrets(["add", "pin", "x"], {}, cli())).toBe(1);
    expect(await runSecrets(["list"], {}, cli())).toBe(0);
    expect(await runSecrets(["init"], { passphrase: true }, cli(["one passphrase", "another one"]))).toBe(1);
    expect(lines.at(-1)).toMatch(/differ/);
  });
});

describe("kos secrets migrate-env", () => {
  const ENV = ["# KOS", "OPENAI_API_KEY=sk-proj-env-canary-0123456789", "DISCORD_TOKEN=discord-env-canary-0123456789", "KOS_SECRET_STRIPE=sk_live_env_canary_0123", "KOS_SECRET_STRIPE_HOSTS=api.stripe.com", "KOS_HOOK_SECRET=hook-env-canary-0123", "KOS_DASHBOARD_TOKEN=dash-env-canary-0123", "KOS_PORT=4317", ""].join("\n");
  const at = (answers: string[] = []): SecretsCli => ({ ...cli(answers), envPath: join(root, ".env"), verifiers: new Verifiers(join(root, "kos")) });

  beforeEach(() => writeFileSync(join(root, ".env"), ENV, { mode: 0o600 }));

  it("lists what it would move on a dry run, and changes nothing", async () => {
    await runSecrets(["init"], {}, cli());
    expect(await runSecrets(["migrate-env"], { "dry-run": true }, at())).toBe(0);
    expect(lines).toContain("  OPENAI_API_KEY -> the vault, as KOS's openai key");
    expect(lines).toContain("  DISCORD_TOKEN -> the vault, as KOS's discord key");
    expect(lines).toContain("  KOS_SECRET_STRIPE -> the vault, as KOS's stripe key");
    expect(lines.some((l) => l.startsWith("  KOS_HOOK_SECRET -> a check"))).toBe(true);
    expect(lines.join("\n")).not.toMatch(/DASHBOARD|HOSTS|KOS_PORT/);
    expect(readFileSync(join(root, ".env"), "utf8")).toBe(ENV);
    expect(new Vault({ dir: join(root, "secrets") }).list()).toEqual([]);
  });

  it("moves after the confirm, blanks the values, keeps the names, and moves nothing the second time", async () => {
    await runSecrets(["init"], {}, cli());
    expect(await runSecrets(["migrate-env"], {}, at(["no"]))).toBe(1);
    expect(readFileSync(join(root, ".env"), "utf8")).toBe(ENV);
    expect(await runSecrets(["migrate-env"], {}, at(["move"]))).toBe(0);
    const file = readFileSync(join(root, ".env"), "utf8");
    for (const canary of ["sk-proj-env-canary", "discord-env-canary", "sk_live_env_canary", "hook-env-canary"]) expect(file).not.toContain(canary);
    expect(file).toContain("# OPENAI_API_KEY= moved to the KOS vault as its openai key (kos secrets list)");
    expect(file).toContain("# KOS_HOOK_SECRET= kept as a check in ~/.kos (Settings, Providers)");
    expect(file).toContain("KOS_SECRET_STRIPE_HOSTS=api.stripe.com");
    expect(file).toContain("KOS_DASHBOARD_TOKEN=dash-env-canary-0123");
    const vault = new Vault({ dir: join(root, "secrets") });
    const secrets = SecretsRegistry.fromEnv({ KOS_SECRET_STRIPE_HOSTS: "api.stripe.com" } as NodeJS.ProcessEnv);
    secrets.attachVault(vault);
    expect(secrets.credential("openai")).toBe("sk-proj-env-canary-0123456789");
    expect(secrets.credential("discord")).toBe("discord-env-canary-0123456789");
    expect(secrets.get("stripe")).toBe("sk_live_env_canary_0123");
    expect(secrets.hostsOf("stripe")).toEqual(["api.stripe.com"]);
    expect(new Verifiers(join(root, "kos")).matches("hook", "hook-env-canary-0123")).toBe(true);
    lines = [];
    expect(await runSecrets(["migrate-env"], {}, at())).toBe(0);
    expect(lines).toEqual([`nothing in ${join(root, ".env")} to move`]);
    expect(vault.list()).toHaveLength(3);
  });

  it("finishes a run cut short: a key already in the vault with the same value is only blanked; another value is left alone", async () => {
    await runSecrets(["init"], {}, cli());
    const vault = new Vault({ dir: join(root, "secrets") });
    vault.add({ label: "OpenAI", kind: "apikey", values: { token: "sk-proj-env-canary-0123456789" }, use: { harness: "openai" } });
    vault.add({ label: "Discord", kind: "apikey", values: { token: "another-discord-token-0123" }, use: { harness: "discord" } });
    expect(await runSecrets(["migrate-env"], { yes: true }, at())).toBe(0);
    expect(lines).toContain("  OPENAI_API_KEY -> the vault, as KOS's openai key (already there; only blanked in .env)");
    expect(lines).toContain("  DISCORD_TOKEN: the vault's discord key holds another value; left as it is");
    const file = readFileSync(join(root, ".env"), "utf8");
    expect(file).not.toContain("sk-proj-env-canary");
    expect(file).toContain("DISCORD_TOKEN=discord-env-canary-0123456789");
    expect(vault.list().filter((m) => m.use.harness === "openai")).toHaveLength(1);
  });

  it("needs a vault to move into", async () => {
    expect(await runSecrets(["migrate-env"], { yes: true }, at())).toBe(1);
    expect(lines.at(-1)).toMatch(/no vault to move keys into/);
  });
});
