/**
 * A size as Finder says one: in thousands, the way a disk is sold, one
 * decimal under ten and none past it. One formatter for every size the
 * dashboard shows (the file list, Get Info, Quick Look, a mentioned file),
 * so one file never reads as two sizes.
 */
export function bytesWords(bytes: number): string {
  if (bytes < 1000) return `${bytes} byte${bytes === 1 ? "" : "s"}`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes / 1000;
  let unit = 0;
  while (n >= 999.5 && unit < units.length - 1) {
    n /= 1000;
    unit++;
  }
  return `${n < 9.95 ? n.toFixed(1).replace(/\.0$/, "") : Math.round(n)} ${units[unit]}`;
}
