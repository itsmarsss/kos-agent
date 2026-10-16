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
 * front of a command.
 */

/** Programs that read whatever their arguments say and change nothing. */
const PLAIN = new Set([
  "ls", "cat", "head", "tail", "wc", "pwd", "echo", "printf", "true", "false", "date", "cal",
  "whoami", "id", "uname", "hostname", "which", "type", "file", "stat", "du", "df", "tree", "nl",
  "column", "sort", "uniq", "cut", "tr", "paste", "fold", "fmt", "basename", "dirname", "realpath",
  "readlink", "md5", "md5sum", "shasum", "sha1sum", "sha256sum", "cksum", "jq", "yq", "env",
  "printenv", "ps", "uptime", "sw_vers", "arch", "grep", "egrep", "fgrep", "rg", "ag", "diff",
  "cmp", "comm", "strings", "od", "xxd", "hexdump", "less", "more", "tac", "rev", "expand",
  "unexpand", "seq", "expr", "test", "[", "cd", "tput", "locale", "nproc", "getconf",
]);

/** Options that make `find` act on what it finds. */
const FIND_ACTS = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"]);

/** `git` subcommands that read, each with the options that keep them so. */
const GIT_READS: Record<string, (args: string[]) => boolean> = {
  status: () => true,
  log: () => true,
  diff: () => true,
  show: () => true,
  blame: () => true,
  describe: () => true,
  shortlog: () => true,
  "rev-parse": () => true,
  "ls-files": () => true,
  "ls-tree": () => true,
  "cat-file": () => true,
  "name-rev": () => true,
  "for-each-ref": () => true,
  "check-ignore": () => true,
  "count-objects": () => true,
  grep: () => true,
  branch: (args) => !args.some((a) => /^-(d|D|m|M|c|C|u)$/.test(a) || /^--(delete|move|copy|set-upstream|unset-upstream|edit-description)/.test(a)),
  // Listing only: a pattern is fine beside -l, a name on its own would make one.
  tag: (args) => args.every((a) => a === "-l" || a === "--list" || /^-n\d*$/.test(a) || (!a.startsWith("-") && (args.includes("-l") || args.includes("--list")))),
  remote: (args) => args.length === 0 || args[0] === "-v" || args[0] === "show" || args[0] === "get-url",
  stash: (args) => args[0] === "list" || args[0] === "show",
  reflog: (args) => args.length === 0 || args[0] === "show",
  config: (args) => args.some((a) => a === "-l" || a === "--list" || a.startsWith("--get")),
  worktree: (args) => args[0] === "list",
};

/** `pnpm`, `npm` and `yarn` subcommands that only report. */
const PACKAGE_READS = new Set(["ls", "list", "-v", "--version", "outdated", "why", "root", "bin"]);

interface Word {
  text: string;
  /** Holds an unquoted < or >: a redirection, not an argument. */
  redirect: boolean;
}

type Token = { kind: "word"; word: Word } | { kind: "join" };

/**
 * The line as words and joins, honouring quotes and backslashes. Nothing
 * when it holds something that cannot be followed: a substitution, a
 * subshell, a background job, an open quote.
 */
function tokens(command: string): Token[] | undefined {
  const out: Token[] = [];
  let text = "";
  let redirect = false;
  let have = false;
  let quote: string | null = null;
  const flush = (): void => {
    if (have) out.push({ kind: "word", word: { text, redirect } });
    text = "";
    redirect = false;
    have = false;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    const next = command[i + 1];
    if (quote) {
      if (ch === quote) quote = null;
      else text += ch;
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
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    if (ch === "`" || ch === "(" || ch === ")") return undefined;
    if (ch === "$" && next === "(") return undefined;
    if (ch === "|" || ch === ";" || ch === "\n") {
      flush();
      out.push({ kind: "join" });
      if (ch === "|" && next === "|") i++;
      continue;
    }
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
    if (ch === "<" || ch === ">") redirect = true;
    text += ch;
    have = true;
  }
  if (quote) return undefined;
  flush();
  return out;
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
    // Reading from a file is fine; the file is the next word when not attached.
    if (/^<$/.test(w.text)) {
      i++;
      continue;
    }
    if (/^<[^<>]+$/.test(w.text)) continue;
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
  switch (program) {
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
    case "pnpm":
    case "npm":
    case "yarn":
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

/** True when every command on the line is a known read-only program used read-only. */
export function isReadOnlyCommand(command: string): boolean {
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
    const program = first.includes("/") ? first.slice(first.lastIndexOf("/") + 1) : first;
    if (!readsOnly(program, args.slice(1))) return false;
  }
  return true;
}
