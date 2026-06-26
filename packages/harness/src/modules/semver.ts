/**
 * Minimal version-range matching for module capability dependencies. Supports
 * "*"/empty (any), exact, caret ("^x.y.z": same major, >= the floor), and
 * ">=x.y.z". Enough for declared capability deps without a full semver dep.
 */

function num(s: string | undefined): number {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function parse(v: string): [number, number, number] {
  const p = v.split(".");
  return [num(p[0]), num(p[1]), num(p[2])];
}

function gte(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[i]! > b[i]!) return true;
    if (a[i]! < b[i]!) return false;
  }
  return true;
}

export function satisfies(version: string, range: string): boolean {
  const r = range.trim();
  if (r === "" || r === "*") return true;

  if (r.startsWith("^")) {
    const floor = parse(r.slice(1));
    const v = parse(version);
    return v[0] === floor[0] && gte(v, floor);
  }

  if (r.startsWith(">=")) {
    return gte(parse(version), parse(r.slice(2)));
  }

  return version === r;
}
