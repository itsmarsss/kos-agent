/**
 * Math in KOS's words, as LaTeX: where it starts and ends, for every surface
 * that renders it, so the dashboard and the side panel agree on what is a
 * formula and what is a price.
 *
 * Display math is $$...$$ or \[...\]; inline math is \(...\) or $...$. A
 * single dollar is also money, so it opens math only when a non-space
 * follows it and nothing word-like comes before, and closes only after a
 * non-space and when no digit follows: "$5 and $10" and "$3-$4" stay prices.
 * It never reaches into a code span: "$10, not `$y$`" is a price and code.
 */
export const MATH =
  /\$\$([^\n]+?)\$\$|\\\[([^\n]+?)\\\]|\\\(([^\n]+?)\\\)|(?<![\\$\w])\$(?![\s$])((?:\\.|[^$\\\n`])+?)(?<![\s\\])\$(?!\d)/;

export interface MathSource {
  tex: string;
  display: boolean;
}

/** What a MATH match holds. */
export function mathOf(match: RegExpExecArray): MathSource {
  const display = match[1] ?? match[2];
  return display !== undefined ? { tex: display.trim(), display: true } : { tex: (match[3] ?? match[4] ?? "").trim(), display: false };
}

const CLOSERS: Record<string, string> = { "$$": "$$", "\\[": "\\]" };

/**
 * Display math set on lines of its own, starting at line i: its source and
 * the line after it. Nothing when line i does not open it, when it closes
 * mid-line (an inline span, then words), or when it never closes.
 */
export function displayMathAt(lines: string[], i: number): { tex: string; next: number } | undefined {
  const first = (lines[i] ?? "").trim();
  const open = first.slice(0, 2);
  const close = CLOSERS[open];
  if (!close) return undefined;
  const rest = first.slice(2);
  const end = rest.indexOf(close);
  if (end !== -1) return end === rest.length - close.length && end > 0 ? { tex: rest.slice(0, end).trim(), next: i + 1 } : undefined;
  const body = [rest];
  for (let j = i + 1; j < lines.length; j++) {
    const line = (lines[j] ?? "").trimEnd();
    const at = line.indexOf(close);
    if (at === -1) {
      body.push(line);
      continue;
    }
    if (at !== line.length - close.length) return undefined;
    body.push(line.slice(0, at));
    return { tex: body.join("\n").trim(), next: j + 1 };
  }
  return undefined;
}
