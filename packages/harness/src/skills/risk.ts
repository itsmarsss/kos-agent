/**
 * Risk assessment for agent-written skills.
 *
 * The model never declares whether its own skill is risky. KOS.md draws the
 * safe line at "read-only, no money, no external send, no credentials", so a
 * skill qualifies as safe only when nothing in its source reaches for a write,
 * the network, the environment, another process, or dynamic code. Anything
 * unrecognised is risky: this fails closed, because the cost of a false "safe"
 * is arbitrary agent-written code auto-committing after a dry-run test that,
 * by design, mocked exactly the effects worth worrying about.
 */

export interface SkillRisk {
  risky: boolean;
  /** Human-readable reasons, for the approval prompt and the audit log. */
  reasons: string[];
}

interface Marker {
  label: string;
  pattern: RegExp;
}

const MARKERS: Marker[] = [
  {
    label: "network access",
    pattern:
      /\b(fetch|XMLHttpRequest|WebSocket)\s*\(|node:(https?|net|dgram|tls)|require\(\s*['"](https?|net|dgram|tls)['"]|\b(axios|undici|node-fetch)\b/,
  },
  {
    label: "process execution",
    pattern:
      /node:child_process|require\(\s*['"]child_process['"]|\b(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/,
  },
  {
    label: "credentials or environment",
    pattern: /process\.env|KOS_SECRET|\{\{\s*secret:/,
  },
  {
    label: "dynamic code execution",
    pattern: /\beval\s*\(|new\s+Function\s*\(|node:vm|require\(\s*['"]vm['"]/,
  },
  {
    label: "filesystem writes",
    pattern:
      /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|mkdir|mkdirSync|rm|rmSync|rmdir|unlink|unlinkSync|rename|renameSync|copyFile|copyFileSync|truncate|chmod|chown)\s*\(/,
  },
  {
    label: "database writes",
    pattern:
      /\b(insert\s+into|update\s+\w+\s+set|delete\s+from|drop\s+table|alter\s+table|create\s+table|replace\s+into|truncate\s+table)\b/i,
  },
  {
    label: "process control",
    pattern: /process\.(exit|kill|abort)\s*\(|\bprocess\.binding\b/,
  },
];

/**
 * Classify a skill's source. Comments are stripped first so a marker mentioned
 * in prose does not force approval, while string literals are kept: a SQL write
 * or a URL lives in a string and is exactly what we are looking for.
 */
export function assessSkillRisk(source: string): SkillRisk {
  if (typeof source !== "string" || source.trim() === "") {
    return { risky: true, reasons: ["empty or unreadable skill source"] };
  }

  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ");

  const reasons = MARKERS.filter((m) => m.pattern.test(code)).map((m) => m.label);
  return { risky: reasons.length > 0, reasons };
}
