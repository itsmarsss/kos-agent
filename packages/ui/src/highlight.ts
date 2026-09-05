/**
 * Colouring source, without a library.
 *
 * A file in the viewer was one grey wall, which is fine for a note and no
 * good for the code KOS writes: the shape of a function is carried by which
 * words are keywords and which are strings, and none of that was visible.
 *
 * This is deliberately not a parser. It finds the few kinds of run that
 * matter -- comment, string, number, keyword, punctuation -- in one pass, and
 * anything it does not recognise stays plain. Being wrong here means a word
 * is the ordinary colour, which is what it was before, so the failure mode is
 * the old behaviour rather than mangled text.
 *
 * Written rather than installed because the whole job is a few hundred lines,
 * the languages are the handful a workspace holds, and a highlighter is a
 * large dependency to carry for one panel.
 */

export type TokenKind =
  | "plain"
  | "comment"
  | "string"
  | "number"
  | "keyword"
  | "type"
  | "punctuation";

export interface Token {
  kind: TokenKind;
  text: string;
}

/** Words that make a language's shape legible, by family. */
const KEYWORDS: Record<string, string[]> = {
  javascript: [
    "async", "await", "break", "case", "catch", "class", "const", "continue",
    "default", "delete", "do", "else", "export", "extends", "finally", "for",
    "from", "function", "if", "import", "in", "instanceof", "let", "new", "of",
    "return", "static", "super", "switch", "this", "throw", "try", "typeof",
    "var", "void", "while", "yield",
  ],
  typescript: [
    "abstract", "as", "declare", "enum", "implements", "interface", "keyof",
    "namespace", "private", "protected", "public", "readonly", "satisfies",
    "type",
  ],
  python: [
    "and", "as", "assert", "async", "await", "break", "class", "continue",
    "def", "del", "elif", "else", "except", "finally", "for", "from", "global",
    "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass",
    "raise", "return", "try", "while", "with", "yield",
  ],
  bash: [
    "case", "do", "done", "elif", "else", "esac", "export", "fi", "for",
    "function", "if", "in", "local", "return", "then", "until", "while",
  ],
  sql: [
    "and", "as", "asc", "by", "create", "delete", "desc", "distinct", "drop",
    "from", "group", "having", "insert", "into", "join", "left", "limit",
    "not", "null", "on", "or", "order", "select", "set", "table", "update",
    "values", "where",
  ],
  css: [],
  yaml: [],
  toml: [],
  json: [],
};

/** Words that name a thing rather than do one. Coloured apart from keywords. */
const LITERALS = new Set([
  "true", "false", "null", "undefined", "None", "True", "False", "NaN",
  "Infinity", "self",
]);

interface Rules {
  /** Line comments, longest marker first so "//" wins over "/". */
  line: string[];
  /** Block comment open and close. */
  block?: [string, string];
  quotes: string[];
  words: Set<string>;
  /** Language families sharing one word list, e.g. tsx is ts plus js. */
}

function rulesFor(language: string): Rules {
  const lang = language.toLowerCase();
  if (lang === "python") {
    return {
      line: ["#"],
      quotes: ['"""', "'''", '"', "'"],
      words: new Set(KEYWORDS.python),
    };
  }
  if (lang === "bash" || lang === "sh" || lang === "shell") {
    return { line: ["#"], quotes: ['"', "'"], words: new Set(KEYWORDS.bash) };
  }
  if (lang === "sql") {
    return {
      line: ["--"],
      block: ["/*", "*/"],
      quotes: ["'", '"'],
      words: new Set(KEYWORDS.sql),
    };
  }
  if (lang === "yaml" || lang === "toml") {
    return { line: ["#"], quotes: ['"', "'"], words: new Set() };
  }
  if (lang === "json") {
    return { line: [], quotes: ['"'], words: new Set() };
  }
  if (lang === "css") {
    return { line: [], block: ["/*", "*/"], quotes: ['"', "'"], words: new Set() };
  }
  if (lang === "html" || lang === "xml") {
    return { line: [], block: ["<!--", "-->"], quotes: ['"', "'"], words: new Set() };
  }
  // Everything else is read as the C family, which covers ts, js and the
  // languages that borrowed their punctuation.
  return {
    line: ["//"],
    block: ["/*", "*/"],
    quotes: ['"', "'", "`"],
    words: new Set([...KEYWORDS.javascript!, ...KEYWORDS.typescript!]),
  };
}

/** Is this a language worth colouring at all? */
export function highlights(language: string): boolean {
  const lang = language.toLowerCase();
  return lang !== "" && lang !== "markdown" && lang !== "csv";
}

const WORD_START = /[A-Za-z_$]/;
const WORD = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;
const PUNCT = /[{}[\]()<>;,.:?!=+\-*/%&|^~]/;

/**
 * Split source into coloured runs.
 *
 * One pass, no lookahead beyond the current construct: a string runs to its
 * closing quote or the end of the line, a comment to its terminator or the
 * end of the file. Unterminated things are coloured to the end rather than
 * abandoning the rest of the file as plain, because a file being edited is
 * unterminated most of the time.
 */
export function tokenize(source: string, language: string): Token[] {
  const rules = rulesFor(language);
  const out: Token[] = [];
  let plain = "";

  const flush = (): void => {
    if (plain) {
      out.push({ kind: "plain", text: plain });
      plain = "";
    }
  };
  const push = (kind: TokenKind, text: string): void => {
    flush();
    out.push({ kind, text });
  };

  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);

    const line = rules.line.find((marker) => rest.startsWith(marker));
    if (line) {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      push("comment", source.slice(i, stop));
      i = stop;
      continue;
    }

    if (rules.block && rest.startsWith(rules.block[0])) {
      const close = source.indexOf(rules.block[1], i + rules.block[0].length);
      const stop = close === -1 ? source.length : close + rules.block[1].length;
      push("comment", source.slice(i, stop));
      i = stop;
      continue;
    }

    const quote = rules.quotes.find((q) => rest.startsWith(q));
    if (quote) {
      let j = i + quote.length;
      while (j < source.length) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source.startsWith(quote, j)) {
          j += quote.length;
          break;
        }
        // A single-quoted run does not cross a line in any of these
        // languages, and letting it would colour the rest of the file.
        if (source[j] === "\n" && quote.length === 1 && quote !== "`") break;
        j += 1;
      }
      push("string", source.slice(i, Math.min(j, source.length)));
      i = Math.min(j, source.length);
      continue;
    }

    const ch = source[i]!;

    if (DIGIT.test(ch) && !WORD.test(source[i - 1] ?? " ")) {
      let j = i;
      while (j < source.length && /[0-9a-fA-FxXoObB._]/.test(source[j]!)) j += 1;
      push("number", source.slice(i, j));
      i = j;
      continue;
    }

    if (WORD_START.test(ch)) {
      let j = i;
      while (j < source.length && WORD.test(source[j]!)) j += 1;
      const word = source.slice(i, j);
      if (rules.words.has(word)) push("keyword", word);
      else if (LITERALS.has(word)) push("type", word);
      else plain += word;
      i = j;
      continue;
    }

    if (PUNCT.test(ch)) {
      push("punctuation", ch);
      i += 1;
      continue;
    }

    plain += ch;
    i += 1;
  }

  flush();
  return out;
}
