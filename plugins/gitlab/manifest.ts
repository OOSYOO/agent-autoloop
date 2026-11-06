import type { Finding } from "./report.ts";
import { canonical, hash } from "./storage.ts";
type Refs = { head_sha: string };
export function manifest(
  instanceKey: string,
  projectId: number,
  mrIid: number,
  reportHash: string,
  policyHash: string,
  refs: Refs,
  findings: Finding[],
) {
  const items = findings
    .flatMap((f) => {
      if (f.severity === "P3") return [];
      const position = null;
      const location = `\n\n位置：${f.path}（${f.side === "new" ? "新" : "旧"}版本${f.line === null ? "，无行号" : `第 ${f.line} 行`}）`;
      const body = `[${f.severity}] ${f.title}${location}\n\n${f.evidence}\n\n影响：${f.impact}\n\n建议：${f.suggestion}`;
      const actionKey = hash(canonical([instanceKey, projectId, mrIid, refs.head_sha, body, position]));
      return [{ body, position, actionKey, path: f.path, side: f.side, line: f.line }];
    })
    .sort(
      (a, b) =>
        a.path.localeCompare(b.path, "en") ||
        a.side.localeCompare(b.side, "en") ||
        (a.line ?? 0) - (b.line ?? 0) ||
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

export function severityManifests(
  instanceKey: string,
  projectId: number,
  mrIid: number,
  reportHash: string,
  policyHash: string,
  refs: Refs,
  findings: Finding[],
) {
  const make = (selected: Finding[]) => manifest(instanceKey, projectId, mrIid, reportHash, policyHash, refs, selected);
  return {
    automatic: {
      ...make(findings.filter((f) => f.severity === "P0" || f.severity === "P1")),
      mode: "severity-auto" as const,
    },
    manual: { ...make(findings.filter((f) => f.severity === "P2")), mode: "severity-manual" as const },
  };
}
