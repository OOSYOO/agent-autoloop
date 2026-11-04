import { positionFor } from "./diff.ts";
import type { Finding } from "./report.ts";
import { canonical, hash } from "./storage.ts";
type Refs = Parameters<typeof positionFor>[1];
type Diffs = Parameters<typeof positionFor>[0];
export function manifest(
  instanceKey: string,
  projectId: number,
  mrIid: number,
  reportHash: string,
  policyHash: string,
  refs: Refs,
  findings: Finding[],
  diffs: Diffs,
) {
  const items = findings
    .flatMap((f) => {
      if (f.severity === "P3" || f.line === null) return [];
      const position = positionFor(diffs, refs, f.path, f.side, f.line);
      if (!position) return [];
      const body = `[${f.severity}] ${f.title}\n\n${f.evidence}\n\n影响：${f.impact}\n\n建议：${f.suggestion}`;
      const actionKey = hash(canonical([instanceKey, projectId, mrIid, refs.head_sha, body, position]));
      return [{ body, position, actionKey, path: f.path, side: f.side, line: f.line }];
    })
    .sort(
      (a, b) =>
        a.path.localeCompare(b.path, "en") ||
        a.side.localeCompare(b.side, "en") ||
        a.line - b.line ||
        a.body.localeCompare(b.body, "en"),
    );
  return {
    schema: 1,
    reportHash,
    headSha: refs.head_sha,
    policyHash,
    items: items.map(({ body, position, actionKey }) => ({ body, position, actionKey })),
  };
}
