import { diffLines } from "diff";

/** Approximate line additions/removals (like git diff --stat). */
export function lineDiffStats(oldStr: string, newStr: string): { additions: number; deletions: number } {
  const parts = diffLines(oldStr, newStr);
  let additions = 0;
  let deletions = 0;
  for (const part of parts) {
    const n = lineCount(part.value);
    if (part.added) additions += n;
    if (part.removed) deletions += n;
  }
  return { additions, deletions };
}

function lineCount(s: string): number {
  if (!s) return 0;
  const split = s.split(/\r?\n/);
  let n = split.length;
  if (n > 0 && s.endsWith("\n")) n -= 1;
  return Math.max(0, n);
}

export function isProbablyBinaryUtf8(uint8: Uint8Array): boolean {
  if (uint8.length === 0) return false;
  if (uint8.includes(0)) return true;
  const sample = uint8.subarray(0, Math.min(uint8.length, 8000));
  let printable = 0;
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i];
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126)) printable++;
  }
  return printable / sample.length < 0.85;
}
