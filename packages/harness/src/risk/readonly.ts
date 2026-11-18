/**
 * Which shell commands only look.
 *
 * shell.run is risky by floor, so every call asked. Most of what an agent
 * runs there reads: a listing, a file, a grep, git status. Asking for each
 * of those trains the owner to click yes, which is the one thing an
 * approval queue must not do. A command line this can prove only reads
 * runs as safe; anything it cannot prove stays risky. Proof is an
 * allow-list, never a deny-list: a program it does not know is a program
 * that asks.
 *
 * The shape it accepts: plain commands joined by pipes, `&&`, `||`, `;` or
 * newlines, each one a known read-only program with arguments that keep
 * it so. No substitutions, no subshells, no redirection that writes
 * anywhere but /dev/null, no backgrounding, no environment assignments in
 * front of a command, and no program named by a path: `./ls` or `bin/cat`
 * is whatever the agent wrote there, not the reader it is named after.
 * Readers with an option that runs a program or writes a file (rg --pre,
 * sort -o, find -exec, git log --output) are read-only only without it.
 */

/** Programs that read whatever their arguments say and change nothing. */
const PLAIN = new Set([
  "ls", "cat", "head", "tail", "wc", "pwd", "echo", "printf", "true", "false", "date", "cal",
  "whoami", "id", "uname", "hostname", "which", "type", "stat", "du", "df", "nl",
  "column", "cut", "tr", "paste", "fold", "fmt", "basename", "dirname", "realpath",
  "readlink", "md5", "md5sum", "shasum", "sha1sum", "sha256sum", "cksum", "jq",
  "printenv", "ps", "uptime", "sw_vers", "arch", "grep", "egrep", "fgrep", "diff",
  "cmp", "comm", "strings", "od", "hexdump", "tac", "rev", "expand",
  "unexpand", "seq", "expr", "test", "[", "cd", "tput", "locale", "nproc", "getconf",
]);

/**
 * What of a reader's options make it run or write, and how its short
 * options read. Long options match by any prefix that could stand for
 * one, as getopt and git take `--outp` for `--output`, with or without
 * `=value`; short options are read through a cluster (`-uo`), where a
 * letter that takes a value ends it. Nothing after `--` is an option.
 */
interface Danger {
  long?: string[];
  short?: string;
  /** Short letters whose value is the rest of the cluster, or the next word. */
  takes?: string;
}

function hasDanger(args: string[], d: Danger): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") return false;
    if (a.startsWith("--")) {
      const name = a.split("=")[0]!;
      if (d.long?.some((l) => l.startsWith(name))) return true;
      continue;
    }
    if (!a.startsWith("-") || a === "-") continue;
    for (let j = 1; j < a.length; j++) {
      const c = a[j]!;
      if (d.short?.includes(c)) return true;
      if (d.takes?.includes(c)) {
        if (j === a.length - 1) i++;
        break;
      }
    }
  }
  return false;
}

/** The words that are not options, with the values of `takes` letters set aside. */
function operands(args: string[], takes: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") return [...out, ...args.slice(i + 1)];
    if (!a.startsWith("-") || a === "-") {
      out.push(a);
      continue;
    }
    if (a.startsWith("--")) continue;
    const at = [...a.slice(1)].findIndex((c) => takes.includes(c));
    if (at === a.length - 2) i++;
  }
  return out;
}

/** Readers that run nothing and write nothing unless told to, and what tells them. */
const GUARDED: Record<string, Danger> = {
  rg: { long: ["--pre", "--pre-glob"] },
  ag: { long: ["--pager"] },
  sort: { long: ["--output", "--compress-program"], short: "o", takes: "ktST" },
  // -o names a file to write; -R writes an HTML page into every folder.
  tree: { long: ["--output"], short: "oR", takes: "LPIHT" },
  file: { long: ["--compile"], short: "C", takes: "mfFeP" },
  yq: { long: ["--inplace", "--in-place", "--split-exp"], short: "is", takes: "Iop" },
};

/** `git log`, `diff`, `show` and their kin: --output writes a file, --ext-diff runs diff.external. */
const GIT_LOG: Danger = { long: ["--output", "--ext-diff"], short: "o", takes: "SGUnMCBlO" };

const logReads = (args: string[]): boolean => !hasDanger(args, GIT_LOG);

/** `git branch` options that only list, and those that take the next word as their value. */
const BRANCH_LISTS = /^(-[arvil]+|--(all|remotes|verbose|list|show-current|ignore-case|no-color|no-abbrev|omit-empty)|--(color|sort|format|abbrev|column|contains|no-contains|merged|no-merged|points-at)(=.*)?|--no-column)$/;
const BRANCH_VALUES = new Set(["--sort", "--format", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at"]);

/** A `git branch` that lists: listing options only, and names only as a pattern beside --list or as an option's value. */
function branchLists(args: string[]): boolean {
  const listing = args.some((a) => a === "--list" || /^-[arvi]*l[arvi]*$/.test(a));
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (BRANCH_VALUES.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-") ? !BRANCH_LISTS.test(a) : !listing) return false;
  }
  return true;
}

/** `git config` actions that change something; beside a read, git refuses the pair, but none is let through. */
const CONFIG_WRITES = /^(--(add|replace-all|unset|unset-all|rename-section|remove-section|edit)|-e)$/;

/** Options that make `find` act on what it finds. */
const FIND_ACTS = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"]);

/** `git` subcommands that read, each with the options that keep them so. */
const GIT_READS: Record<string, (args: string[]) => boolean> = {
  status: () => true,
  log: logReads,
  diff: logReads,
  show: logReads,
  shortlog: logReads,
  blame: () => true,
  describe: () => true,
  "rev-parse": () => true,
  "ls-files": () => true,
  "ls-tree": () => true,
  "cat-file": () => true,
  "name-rev": () => true,
  "for-each-ref": () => true,
  "check-ignore": () => true,
  "count-objects": () => true,
  // -O opens the matches in a pager it names.
  grep: (args) => !hasDanger(args, { long: ["--open-files-in-pager"], short: "O", takes: "efABCm" }),
  branch: branchLists,
  // Listing only: a pattern is fine beside -l, a name on its own would make one.
  tag: (args) => args.every((a) => a === "-l" || a === "--list" || /^-n\d*$/.test(a) || (!a.startsWith("-") && (args.includes("-l") || args.includes("--list")))),
  // show asks the remote unless -n keeps it to what is known.
  remote: (args) => args.every((a) => a === "-v" || a === "--verbose") || (args[0] === "show" && args.includes("-n")) || args[0] === "get-url",
  // list and show take git log's options, --output among them.
  stash: (args) => (args[0] === "list" || args[0] === "show") && logReads(args.slice(1)),
  reflog: (args) => args.length === 0 || (args[0] === "show" && logReads(args.slice(1))),
  config: (args) => args.some((a) => a === "-l" || a === "--list" || a.startsWith("--get")) && !args.some((a) => CONFIG_WRITES.test(a)),
  worktree: (args) => args[0] === "list",
};

/**
 * `npm` subcommands that only report. Not pnpm or yarn: each may run a
 * program the workspace names on any command, the version a package.json
 * asks for, or a .yarnrc.yml's yarnPath.
 */
const PACKAGE_READS = new Set(["ls", "list", "-v", "--version", "why", "root", "bin"]);

/**
 * Paths a read of which is not harmless: KOS's own files (the database,
 * the browser profile with its cookies, the config with a server's keys)
 * and anything hidden, where a server keeps its tokens. Reading them is
 * exactly what the approval is for, so a line that names one asks.
 */
const PROTECTED = /(^|\/)(\.[^/]+|kos\.sqlite(-shm|-wal)?|profile\.json|mcp\.json|daemon\.json|locks)(\/|$)/;

function namesProtected(arg: string): boolean {
  return PROTECTED.test(arg.replace(/^\.\//, ""));
}

/**
 * The arguments that may be paths. A filter for jq or yq is its first
 * word that is not an option, and it starts with a dot by design, which
 * is not a hidden file; with -f the filter is a file, and every word is a
 * path. Git names a file in a revision as `<rev>:<path>`.
 */
function pathArgs(program: string, args: string[]): string[] {
  const after = (a: string, sep: string): string => a.slice(a.indexOf(sep) + 1);
  // An option's value given as --opt=value is a path as much as a word on its own.
  const values = args.filter((a) => a.startsWith("-") && a.includes("=")).map((a) => after(a, "="));
  if (program === "git") return [...args, ...values, ...args.filter((a) => a.includes(":")).map((a) => after(a, ":"))];
  if (program !== "jq" && program !== "yq") return [...args, ...values];
  if (args.some((a) => a === "-f" || a.startsWith("--from-file"))) return [...args, ...values];
  const filter = args.findIndex((a) => !a.startsWith("-"));
  return [...(filter < 0 ? args : args.filter((_, i) => i !== filter)), ...values];
}

interface Word {
  text: string;
  /** Holds an unquoted < or >: a redirection, not an argument. */
  redirect: boolean;
}

type Token = { kind: "word"; word: Word } | { kind: "join" };

/**
 * The line as words and joins, honouring quotes and backslashes as sh
 * does. Nothing when it holds what the shell would expand into words this
 * cannot see: a $ outside single quotes (a variable, $'...', ${...}), a
 * substitution, braces, a glob that could expand to an option (one at the
 * head of a word, or in a word that is an option), a subshell, a
 * background job, an open quote. `src/*` stays, since what it finds starts
 * with `src/`; `*` and `*.ts` do not.
 */
function tokens(command: string): Token[] | undefined {
  const out: Token[] = [];
  let text = "";
  let redirect = false;
  let have = false;
  let glob = false;
  let globHead = false;
  let quote: string | null = null;
  let bad = false;
  const flush = (): void => {
    if (globHead && text !== "[") bad = true;
    if (glob && text.startsWith("-")) bad = true;
    if (have) out.push({ kind: "word", word: { text, redirect } });
    text = "";
    redirect = false;
    have = false;
    glob = false;
    globHead = false;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    const next = command[i + 1];
    if (quote === "'") {
      if (ch === quote) quote = null;
      else text += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "$" || ch === "`") return undefined;
      else if (ch === "\\" && next !== undefined && '$`"\\\n'.includes(next)) {
        text += next;
        i++;
      } else text += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      have = true;
      continue;
    }
    if (ch === "\\") {
      text += next ?? "";
      have = true;
      i++;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "\n") {
      flush();
      out.push({ kind: "join" });
      if (ch === "|" && next === "|") i++;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    if (ch === "`" || ch === "(" || ch === ")" || ch === "$" || ch === "{" || ch === "}") return undefined;
    if (ch === "&") {
      if (next === "&") {
        flush();
        out.push({ kind: "join" });
        i++;
        continue;
      }
      // Only ever inside a redirection: 2>&1, or &> to the bin.
      if (text.endsWith(">") || (!have && next === ">")) {
        text += ch;
        have = true;
        continue;
      }
      return undefined;
    }
    if (ch === "*" || ch === "?" || ch === "[") {
      if (text === "" || /^\d?[<>]$/.test(text)) globHead = true;
      glob = true;
    }
    if (ch === "<" || ch === ">") redirect = true;
    text += ch;
    have = true;
  }
  if (quote) return undefined;
  flush();
  return bad ? undefined : out;
}

/** The arguments of one command, with its redirections checked and set aside; nothing when one writes. */
function arguments_(words: Word[]): string[] | undefined {
  const args: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (!w.redirect) {
      args.push(w.text);
      continue;
    }
    // Reading from a file is fine, unless it is one a read must ask for; the file is the next word when not attached.
    if (/^<$/.test(w.text)) {
      const from = words[++i];
      if (!from || from.redirect || namesProtected(from.text)) return undefined;
      continue;
    }
    if (/^<[^<>]+$/.test(w.text)) {
      if (namesProtected(w.text.slice(1))) return undefined;
      continue;
    }
    // Output may be thrown away or merged into the other stream; nothing else.
    if (/^\d?>&\d$/.test(w.text)) continue;
    const bin = /^(\d?>|&>)(\/dev\/null)?$/.exec(w.text);
    if (!bin) return undefined;
    if (bin[2]) continue;
    if (words[i + 1]?.text === "/dev/null" && !words[i + 1]?.redirect) {
      i++;
      continue;
    }
    return undefined;
  }
  return args;
}

function readsOnly(program: string, args: string[]): boolean {
  if (PLAIN.has(program)) return true;
  const guarded = GUARDED[program];
  if (guarded) return !hasDanger(args, guarded);
  switch (program) {
    // Bare, it prints the environment; with words, it runs them.
    case "env":
      return args.length === 0;
    // A second operand is the file it writes.
    case "uniq":
      return !hasDanger(args, { long: ["--output"] }) && operands(args, "fsw").length < 2;
    case "xxd":
      return operands(args, "cglosn").length < 2;
    case "find":
      return !args.some((a) => FIND_ACTS.has(a));
    case "git": {
      // Leading options that pick where to look, then the subcommand.
      let i = 0;
      while (i < args.length && (args[i] === "--no-pager" || args[i] === "-C" || args[i] === "-P")) i += args[i] === "-C" ? 2 : 1;
      const sub = args[i];
      if (!sub) return false;
      const rule = GIT_READS[sub];
      return rule ? rule(args.slice(i + 1)) : false;
    }
    case "npm":
      return args.length > 0 && PACKAGE_READS.has(args[0]!);
    case "sed":
      return sedReadsOnly(args);
    default:
      return false;
  }
}

/**
 * `sed` prints lines or substitutes on the way out, and that is all: no
 * -i, and only scripts of the two shapes that cannot name a file to write
 * (a print range, or a simple substitution without the w flag). Scripts are
 * the values of -e, or else the first word that is not an option; whatever
 * follows is the files to read.
 */
function sedReadsOnly(args: string[]): boolean {
  if (args.some((a) => /^-+i/.test(a) || a === "--in-place")) return false;
  const scripts: string[] = [];
  let first: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-e" || a === "--expression") {
      const s = args[++i];
      if (s === undefined) return false;
      scripts.push(s);
    } else if (!a.startsWith("-") && first === undefined) {
      first = a;
    } else if (a.startsWith("-") && !/^-+(n|E|r|quiet|silent|regexp-extended)$/.test(a)) {
      return false;
    }
  }
  if (scripts.length === 0) {
    if (first === undefined) return false;
    scripts.push(first);
  }
  return scripts.every((s) => /^[\d,$]*p$/.test(s) || /^s\/[^/]*\/[^/]*\/[gI\d]*$/.test(s));
}

export interface ReadOnlyOptions {
  /**
   * Whether git can be held (gitHeldOn): new enough for GIT_CONFIG_COUNT
   * and GIT_ATTR_SOURCE. Otherwise a git line asks.
   */
  gitHeld?: boolean;
}

/** True when every command on the line is a known read-only program used read-only. */
export function isReadOnlyCommand(command: string, options: ReadOnlyOptions = {}): boolean {
  const toks = tokens(command);
  if (!toks) return false;
  const commands: Word[][] = [[]];
  for (const t of toks) {
    if (t.kind === "join") commands.push([]);
    else commands[commands.length - 1]!.push(t.word);
  }
  if (commands.some((c) => c.length === 0)) return false;
  for (const words of commands) {
    const args = arguments_(words);
    if (!args || args.length === 0) return false;
    const first = args[0]!;
    if (first.includes("=") || words[0]!.redirect) return false;
    // A program named by a path is whatever was put there, not the reader of that name.
    if (first.includes("/")) return false;
    if (first === "git" && !options.gitHeld) return false;
    if (pathArgs(first, args.slice(1)).some(namesProtected)) return false;
    if (!readsOnly(first, args.slice(1))) return false;
  }
  return true;
}
