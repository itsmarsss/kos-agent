import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Vault } from "@kos/harness";
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

  it("says why a command cannot run", async () => {
    expect(await runSecrets(["unlock"], {}, cli())).toBe(1);
    expect(lines.at(-1)).toMatch(/no host is running/);
    expect(await runSecrets(["add", "pin", "x"], {}, cli())).toBe(1);
    expect(await runSecrets(["list"], {}, cli())).toBe(0);
    expect(await runSecrets(["init"], { passphrase: true }, cli(["one passphrase", "another one"]))).toBe(1);
    expect(lines.at(-1)).toMatch(/differ/);
  });
});
