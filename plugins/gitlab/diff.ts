type Diff = { old_path: string; new_path: string; diff: string; collapsed?: boolean; too_large?: boolean };
type Refs = { base_sha: string; start_sha: string; head_sha: string };
type Position = Refs & {
  position_type: "text";
  old_path: string;
  new_path: string;
  old_line?: number;
  new_line?: number;
};

export function positionFor(
  diffs: Diff[],
  refs: Refs,
  path: string,
  side: "old" | "new",
  line: number,
): Position | null {
  if (!Object.values(refs).every((sha) => /^[a-f0-9]{40}$/.test(sha))) return null;
  const matching = diffs.filter((d) => (side === "old" ? d.old_path : d.new_path) === path);
  if (matching.length !== 1) return null;
  const d = matching[0];
  if (d.collapsed || d.too_large || typeof d.diff !== "string") return null;
  let old = 0,
    next = 0,
    remainingOld = 0,
    remainingNew = 0,
    active = false;
  let match: Position | null = null;
  for (const row of d.diff.split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(row);
    if (header) {
      if (active && (remainingOld || remainingNew)) return null;
      old = Number(header[1]);
      next = Number(header[3]);
      remainingOld = Number(header[2] ?? 1);
      remainingNew = Number(header[4] ?? 1);
      active = true;
      continue;
    }
    if (!active) {
      if (row) return null;
      continue;
    }
    if (row.startsWith("\\")) continue;
    if (!row && remainingOld === 0 && remainingNew === 0) continue;
    const kind = row[0];
    if (kind !== " " && kind !== "+" && kind !== "-") return null;
    const oldLine = kind !== "+" ? old++ : undefined;
    const newLine = kind !== "-" ? next++ : undefined;
    if (oldLine !== undefined) remainingOld--;
    if (newLine !== undefined) remainingNew--;
    if (remainingOld < 0 || remainingNew < 0) return null;
    if ((side === "old" ? oldLine : newLine) === line) {
      if (match) return null;
      match = {
        position_type: "text",
        ...refs,
        old_path: d.old_path,
        new_path: d.new_path,
        ...(oldLine === undefined ? {} : { old_line: oldLine }),
        ...(newLine === undefined ? {} : { new_line: newLine }),
      };
    }
  }
  return active && remainingOld === 0 && remainingNew === 0 ? match : null;
}
