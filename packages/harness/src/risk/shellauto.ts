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

/** A path that stays in the workspace: relative, with no way up and out. */
function inWorkspace(path: string): boolean {
  return !path.startsWith("/") && !path.startsWith("~") && !path.split("/").includes("..");
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
const BUILDS = new Set(["pytest", "make", "tsc", "mkdir", "touch", "tee"]);
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
      if (args.some((a) => /^(-C|-c|--git-dir|--work-tree|--exec-path|--config-env|--namespace|--super-prefix)/.test(a))) return "git pointed elsewhere or reconfigured";
      const sub = args.find((a) => !a.startsWith("-"));
      if (sub === "checkout") return args.includes("-b") ? false : "git checkout, which can throw work away";
      if (sub === "branch") return args.some((a) => /^-[a-zA-Z]*[dDmMcC]/.test(a) || a === "--delete" || a === "--force") ? "git branch that deletes or moves one" : false;
      if (sub === "stash") return ["list", "show", "push", "save", undefined].includes(args[args.indexOf("stash") + 1]) ? false : "git stash that drops work";
      if (sub && GIT_NETWORK.has(sub)) return `git ${sub} needs the network, which a line Auto runs does not have`;
      if (sub === "switch" && args.some((a) => a === "-f" || a === "--force" || a === "--discard-changes")) return "git switch that throws away changes";
      if (args.some((a) => a === "--output" || a.startsWith("--output="))) return "git writing its output to a file";
      return sub && GIT_OK.has(sub) ? false : `git ${sub ?? ""}, which a chat's Auto does not run unasked`.replace("  ", " ");
    }
    case "node":
      // -pe and -re fuse their letters; each long form also takes its value after =.
      return args.some((a) => a === "-" || /^-[a-zA-Z]*[epri]/.test(a) || NODE_CODE.some((o) => a === o || a.startsWith(`${o}=`))) ? "node with code on the line" : !args.length ? "node with no script" : false;
    case "python":
    case "python3":
      // -c takes its code fused too: -cimport os, -Ic'...'.
      if (args.some((a) => a === "-" || /^-[a-zA-Z]*c/.test(a))) return "python with code on the line";
      return args[0] === "-m" && !["pytest", "unittest"].includes(args[1] ?? "") ? "python running a module" : !args.length ? "python with no script" : false;
    case "npm":
    case "pnpm":
    case "yarn": {
      const plain = args.filter((a) => !a.startsWith("-"));
      const script = plain[0] === "run" ? plain[1] : plain[0];
      if (plain[0] === "install" || plain[0] === "i" || plain[0] === "add" || plain[0] === "ci") return `${program} ${plain[0]} needs the network, which a line Auto runs does not have`;
      return script && SCRIPTS.has(script) ? false : `${program} ${plain.join(" ")}, which a chat's Auto does not run unasked`;
    }
    case "cargo":
    case "go":
      return ["build", "test", "check", "vet", "fmt"].includes(args.find((a) => !a.startsWith("-")) ?? "") ? false : runs;
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
 * workspace or onto a file that exists outside scratch (`overwrites`).
 */
export function shellBeyondAuto(line: string, overwrites: (path: string) => boolean): string | false {
  // overwrites: a file (not a folder) is there now outside scratch, so writing it loses what it held.
  const calls = callsOf(line);
  if (typeof calls === "string") return `${calls}, which hides what runs`;
  for (const call of calls) {
    const { words, targets } = withoutRedirects(call);
    targets.push(...writesOf(words));
    for (const { path, truncates } of targets) {
      if (path === "/dev/null" || path === "/dev/stdout" || path === "/dev/stderr") continue;
      if (!inWorkspace(path)) return `writes ${path}, outside the workspace`;
      if (truncates && overwrites(path)) return `overwrites ${path}`;
    }
    const beyond = callBeyond(words);
    if (beyond) return beyond;
  }
  return false;
}
