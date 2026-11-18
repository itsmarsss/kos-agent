import { posix } from "node:path";

/**
 * Which shell lines a chat's Auto may run unasked: an allow-list, not a
 * deny-list. A line is covered only when every program in it (through
 * pipes, &&, || and ;) is one that reads, or builds and tests inside the
 * workspace, called in a way that stays so. Anything else asks, whatever
 * the chat is set to: a deny-list is a list of the bypasses not yet found.
 */

/** One program call of a line: its words with quotes and backslashes taken away. */
type Call = string[];

/**
 * A line split into its program calls, or why it cannot be judged: a
 * substitution or a here-document hides what runs, so it is never covered.
 */
export function callsOf(line: string): Call[] | string {
  const calls: Call[] = [];
  let words: string[] = [];
  let word = "";
  let started = false;
  const endWord = (): void => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  const endCall = (): void => {
    endWord();
    if (words.length) calls.push(words);
    words = [];
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "\\") {
      // A backslash takes the next character as it is: \rm is rm, \\n a line break no more.
      if (line[i + 1] === "\n") i++;
      else if (i + 1 < line.length) {
        word += line[++i];
        started = true;
      }
      continue;
    }
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return "an unclosed quote";
      word += line.slice(i + 1, end);
      started = true;
      i = end;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      for (; j < line.length && line[j] !== '"'; j++) {
        if (line[j] === "\\" && j + 1 < line.length) j++;
        else if (line[j] === "`" || (line[j] === "$" && line[j + 1] === "(")) return "a command substitution";
      }
      if (j >= line.length) return "an unclosed quote";
      word += line.slice(i + 1, j).replace(/\\(.)/g, "$1");
      started = true;
      i = j;
      continue;
    }
    if (c === "`" || (c === "$" && line[i + 1] === "(")) return "a command substitution";
    if ((c === "<" || c === ">") && line[i + 1] === "(") return "a process substitution";
    if (c === "<" && line[i + 1] === "<") return "a here-document";
    if (c === "|" || c === ";" || c === "&" || c === "\n") {
      // >& and &> are redirects, not a split.
      if (c === "&" && (word.endsWith(">") || line[i + 1] === ">")) {
        word += c;
        started = true;
        continue;
      }
      endCall();
      continue;
    }
    if (c === " " || c === "\t") {
      endWord();
      continue;
    }
    word += c;
    started = true;
  }
  endCall();
  return calls;
}

/**
 * What a path names under the child's home, which is the workspace root:
 * ~/x, $HOME/x and ${HOME}/x are the root's x. Null for any other path.
 */
function homeRest(path: string): string | null {
  const m = /^(?:~|\$HOME|\$\{HOME\})(?:\/(.*))?$/.exec(path);
  return m ? m[1] || "." : null;
}

/** A path that stays in the workspace: relative or under ~, with no way up and out and no other variable in it. */
function inWorkspace(path: string): boolean {
  const p = homeRest(path) ?? path;
  return !p.startsWith("/") && !p.startsWith("~") && !p.includes("$") && !p.split("/").includes("..");
}

/** The values a call gives an option, however spelled: -o v, -ov for one letter, and n v or n=v for every name. */
function valuesOf(args: readonly string[], names: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    for (const n of names) {
      if (a === n) out.push(args[i + 1] ?? "");
      else if (a.startsWith(`${n}=`)) out.push(a.slice(n.length + 1));
      else if (/^-[A-Za-z]$/.test(n) && a.startsWith(n)) out.push(a.slice(2));
    }
  }
  return out;
}

/** The first value of these options outside the workspace, or undefined. */
function awayValue(args: readonly string[], names: readonly string[]): string | undefined {
  return valuesOf(args, names).find((v) => !inWorkspace(v));
}

/** A program an option runs: one in the workspace by its path, not a name looked up on PATH. */
function workspaceProgram(value: string): boolean {
  return value.includes("/") && inWorkspace(value);
}

/** Why pytest loads a plugin from the line (-p name), or false; -p no:name only turns one off. */
function pytestPlugin(args: readonly string[]): string | false {
  return valuesOf(args, ["-p"]).some((v) => !v.startsWith("no:")) ? "pytest loading a plugin named on the line" : false;
}

/** The words of a call past its redirects, and the files it writes to with them. */
function withoutRedirects(call: Call): { words: string[]; targets: { path: string; truncates: boolean }[] } {
  const words: string[] = [];
  const targets: { path: string; truncates: boolean }[] = [];
  for (let i = 0; i < call.length; i++) {
    const w = call[i]!;
    const m = /^(\d*|&)(>>?|<)(&?)(.*)$/.exec(w);
    if (!m) {
      words.push(w);
      continue;
    }
    const target = m[4] || call[++i] || "";
    // >&2 and >&- name a descriptor; >&file, like &>file, is a file.
    if (m[2] !== "<" && !(m[3] === "&" && /^(\d+|-)$/.test(target))) targets.push({ path: target, truncates: m[2] === ">" });
  }
  return { words, targets };
}

/**
 * The files a call writes by its own operands, judged as a redirect is: tee's
 * files, -o of sort, uniq and tree, uniq's output operand, the target of cp
 * and mv, and an option's value that names a path (--output=/x).
 */
function writesOf(words: string[]): { path: string; truncates: boolean }[] {
  const at = words.findIndex((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  if (at < 0) return [];
  const program = words[at]!;
  const args = words.slice(at + 1);
  const operands = args.filter((a) => !a.startsWith("-"));
  const out: { path: string; truncates: boolean }[] = [];
  // An option's value that is a path outside the workspace, whatever the option.
  for (const a of args) {
    const v = /^--?[A-Za-z][\w-]*=(.+)$/.exec(a)?.[1];
    if (v && !inWorkspace(v)) out.push({ path: v, truncates: false });
  }
  if (program === "tee") {
    const append = args.some((a) => a === "-a" || a === "--append");
    for (const w of operands) out.push({ path: w, truncates: !append });
  }
  if (program === "sort" || program === "uniq" || program === "tree") {
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === "-o" || a === "--output") out.push({ path: args[i + 1] ?? "", truncates: true });
      else if (/^-o.+/.test(a)) out.push({ path: a.slice(2), truncates: true });
      else if (a.startsWith("--output=")) out.push({ path: a.slice("--output=".length), truncates: true });
    }
    if (program === "uniq" && operands.length >= 2) out.push({ path: operands[1]!, truncates: true });
  }
  if ((program === "cp" || program === "mv") && operands.length >= 2) out.push({ path: operands.at(-1)!, truncates: true });
  return out;
}

/** Assignments before a program that change nothing about what runs. */
const SAFE_ASSIGNMENTS = /^(CI|NODE_ENV|FORCE_COLOR|NO_COLOR|TZ|LANG|LC_[A-Z_]+|DEBUG)$/;

/** Programs that read, and nothing else, however they are called. */
const READS = new Set(["ls", "cat", "head", "tail", "grep", "egrep", "fgrep", "rg", "wc", "sort", "uniq", "diff", "echo", "printf", "pwd", "true", "false", "test", "[", "which", "file", "stat", "du", "df", "date", "basename", "dirname", "realpath", "tr", "cut", "nl", "tree", "cmp", "comm"]);
/** Programs that build or test the workspace, called plainly. */
const BUILDS = new Set(["mkdir", "touch", "tee"]);
/** The package managers' scripts that build, test or check. */
const SCRIPTS = new Set(["build", "test", "lint", "typecheck", "check", "format"]);
/** What git may do unasked: read, and record work locally. */
const GIT_OK = new Set(["status", "log", "diff", "show", "add", "commit", "switch", "rev-parse", "ls-files", "blame", "shortlog", "describe"]);
/** Git that reaches out: under Auto a line runs with no network, so these ask, saying why. */
const GIT_NETWORK = new Set(["fetch", "pull", "clone", "push", "ls-remote", "submodule"]);

/** Node's options that run code from the line, a module or stdin rather than a script. */
const NODE_CODE = ["--eval", "--print", "--require", "--import", "--loader", "--experimental-loader", "--interactive"];

/** Why one call is beyond Auto, or false. */
function callBeyond(call: Call): string | false {
  // An assignment before the program changes its environment, and some (GIT_CONFIG_*, PATH, LD_PRELOAD) change what runs: only a few harmless ones are covered.
  let at = 0;
  while (at < call.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(call[at]!)) {
    const name = call[at]!.slice(0, call[at]!.indexOf("="));
    if (!SAFE_ASSIGNMENTS.test(name)) return `sets ${name}, which a chat's Auto does not set unasked`;
    at++;
  }
  const words = call.slice(at);
  if (!words.length) return false;
  // A program named by its path is not the one on the list, whatever it is called.
  if (words[0]!.includes("/")) return `runs ${words[0]}, a program by its path`;
  const program = words[0]!;
  const args = words.slice(1);
  const runs = `runs ${program}, which a chat's Auto does not run unasked`;
  if (READS.has(program) || BUILDS.has(program)) return false;
  switch (program) {
    case "find":
      return args.some((a) => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(a)) ? "find that runs or deletes" : false;
    case "git": {
      // git's own options come before its command: switch -c and log -C after it are the command's.
      const at = args.findIndex((a) => !a.startsWith("-"));
      const sub = at < 0 ? undefined : args[at];
      if (args.slice(0, at < 0 ? args.length : at).some((a) => /^(-C|-c|--git-dir|--work-tree|--exec-path|--config-env|--namespace|--super-prefix)/.test(a))) return "git pointed elsewhere or reconfigured";
      if (sub === "checkout") return args.includes("-b") ? false : "git checkout, which can throw work away";
      if (sub === "branch") return args.some((a) => /^-[a-zA-Z]*[dDmMcCf]/.test(a) || a === "--delete" || a === "--force") ? "git branch that deletes, moves or resets one" : false;
      if (sub === "stash") return ["list", "show", "push", "save", undefined].includes(args[args.indexOf("stash") + 1]) ? false : "git stash that drops work";
      if (sub && GIT_NETWORK.has(sub)) return `git ${sub} needs the network, which a line Auto runs does not have`;
      if (sub === "switch" && args.some((a) => a === "-f" || a === "--force" || a === "--discard-changes")) return "git switch that throws away changes";
      if (sub === "commit" && args.includes("--amend")) return "git commit --amend, which rewrites a commit";
      if (sub === "switch" && args.some((a) => a === "--orphan" || a === "-C" || a === "--force-create")) return "git switch that resets a branch or starts one with no history";
      if (args.includes("--ext-diff")) return "git running an external diff program";
      if (args.some((a) => a === "--output" || a.startsWith("--output=")) || (["diff", "show", "log"].includes(sub ?? "") && args.some((a) => /^-o/.test(a)))) return "git writing its output to a file";
      return sub && GIT_OK.has(sub) ? false : `git ${sub ?? ""}, which a chat's Auto does not run unasked`.replace("  ", " ");
    }
    case "node":
      // -pe and -re fuse their letters; each long form also takes its value after =.
      return args.some((a) => a === "-" || /^-[a-zA-Z]*[epri]/.test(a) || NODE_CODE.some((o) => a === o || a.startsWith(`${o}=`))) ? "node with code on the line" : !args.length ? "node with no script" : false;
    case "python":
    case "python3":
      // -c takes its code fused too: -cimport os, -Ic'...'.
      if (args.some((a) => a === "-" || /^-[a-zA-Z]*c/.test(a))) return "python with code on the line";
      if (args[0] === "-m" && args[1] === "pytest") return pytestPlugin(args.slice(2));
      return args[0] === "-m" && args[1] !== "unittest" ? "python running a module" : !args.length ? "python with no script" : false;
    case "pytest":
      return pytestPlugin(args);
    case "make": {
      if (args.some((a) => /^(SHELL|\.SHELLFLAGS)=/.test(a))) return "make with its shell set on the line";
      const away = awayValue(args, ["-f", "--file", "--makefile", "-C", "--directory"]);
      return away === undefined ? false : `make pointed at ${away}, outside the workspace`;
    }
    case "tsc": {
      // tsc reads its options in any case: --outdir is --outDir.
      const away = awayValue(args.map((a) => a.toLowerCase()), ["--outdir", "--outfile", "--declarationdir", "--tsbuildinfofile"]);
      return away === undefined ? false : `tsc writing to ${away}, outside the workspace`;
    }
    case "npm":
    case "pnpm":
    case "yarn": {
      const plain = args.filter((a) => !a.startsWith("-"));
      const script = plain[0] === "run" ? plain[1] : plain[0];
      if (plain[0] === "install" || plain[0] === "i" || plain[0] === "add" || plain[0] === "ci") return `${program} ${plain[0]} needs the network, which a line Auto runs does not have`;
      return script && SCRIPTS.has(script) ? false : `${program} ${plain.join(" ")}, which a chat's Auto does not run unasked`;
    }
    case "cargo":
    case "go": {
      if (!["build", "test", "check", "vet", "fmt"].includes(args.find((a) => !a.startsWith("-")) ?? "")) return runs;
      if (program === "cargo") {
        if (args.some((a) => a === "--config" || a.startsWith("--config="))) return "cargo with config set on the line";
        const away = awayValue(args, ["--target-dir"]);
        return away === undefined ? false : `cargo building into ${away}, outside the workspace`;
      }
      const ran = valuesOf(args, ["-exec", "--exec", "-toolexec", "--toolexec"]).find((v) => !workspaceProgram(v));
      if (ran !== undefined) return `go running ${ran}, a program outside the workspace`;
      const away = awayValue(args, ["-o", "--o"]);
      return away === undefined ? false : `go building into ${away}, outside the workspace`;
    }
    case "cp":
    case "mv":
      return args.filter((a) => !a.startsWith("-")).every(inWorkspace) ? false : `${program} to or from outside the workspace`;
    default:
      return runs;
  }
}

/**
 * Why a shell line is beyond a chat's Auto, or false: a program not on the
 * list, called in a way that runs code, deletes or reaches the network, a
 * substitution that hides what runs, or a redirect that writes outside the
 * workspace or onto a file that exists outside scratch (`overwrites`, given
 * the path from the workspace root). `cwd` is where the line runs, from the
 * root; ~ and $HOME are the root, the child's home.
 */
export function shellBeyondAuto(line: string, overwrites: (path: string) => boolean, cwd = "."): string | false {
  // overwrites: a file (not a folder) is there now outside scratch, so writing it loses what it held.
  const calls = callsOf(line);
  if (typeof calls === "string") return `${calls}, which hides what runs`;
  for (const call of calls) {
    const { words, targets } = withoutRedirects(call);
    targets.push(...writesOf(words));
    for (const { path, truncates } of targets) {
      if (path === "/dev/null" || path === "/dev/stdout" || path === "/dev/stderr") continue;
      if (!inWorkspace(path)) return `writes ${path}, outside the workspace`;
      if (truncates && overwrites(homeRest(path) ?? posix.join(cwd, path))) return `overwrites ${path}`;
    }
    const beyond = callBeyond(words);
    if (beyond) return beyond;
  }
  return false;
}
