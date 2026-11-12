import { canonical } from "./storage.ts";
export type Request = {
  schema: 1;
  requestId: string;
  projectId: number;
  mrIid: number;
  headSha: string;
  policyHash: string;
  observation: number;
  origin: "auto" | "manual";
};
function request(value: unknown): value is Request {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    Object.keys(r).sort().join(",") === "headSha,mrIid,observation,origin,policyHash,projectId,requestId,schema" &&
    r.schema === 1 &&
    typeof r.requestId === "string" &&
    /^[a-f0-9]{64}$/.test(r.requestId) &&
    typeof r.policyHash === "string" &&
    /^[a-f0-9]{64}$/.test(r.policyHash) &&
    typeof r.headSha === "string" &&
    /^[a-f0-9]{40}$/.test(r.headSha) &&
    [r.projectId, r.mrIid, r.observation].every((v) => Number.isSafeInteger(v) && (v as number) > 0) &&
    (r.origin === "auto" || r.origin === "manual")
  );
}
export function selectRequest(
  events: { detail: string }[],
  stored: Request[],
  head: string,
  projectId: number,
  mrIid: number,
): Request | null {
  const matches: Request[] = [];
  for (const event of events) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.detail);
    } catch {
      continue;
    }
    if (
      request(parsed) &&
      parsed.projectId === projectId &&
      parsed.mrIid === mrIid &&
      parsed.headSha === head &&
      stored.some((r) => request(r) && canonical(r) === canonical(parsed))
    )
      matches.push(parsed);
  }
  matches.sort((a, b) => b.observation - a.observation);
  return matches[0] ?? null;
}
export function obsoleteCards(
  open: { card: number; title: string; text: string; at: string }[],
  projectId: number,
  mrIid: number,
  head: string,
): { card: number; reason: string }[] {
  return open.flatMap((card) => {
    if (card.title !== "确认发布审查评论") return [];
    const match = /^MR (\d+)\/(\d+)，版本 ([a-f0-9]{40})，/.exec(card.text);
    if (!match || Number(match[1]) !== projectId || Number(match[2]) !== mrIid) return [];
    if (match[3] !== head) return [{ card: card.card, reason: "MR 版本已变化" }];
    return [];
  });
}
export function eventMatches(
  event: { id: string; source: string; type: string; subject: string; detail: string },
  instanceKey: string,
): boolean {
  try {
    const value: unknown = JSON.parse(event.detail);
    return (
      request(value) &&
      event.source === "gitlab" &&
      event.id === `gitlab:${value.requestId}` &&
      event.type === `mr.review.${value.projectId}` &&
      event.subject === `${instanceKey}/${value.projectId}/${value.mrIid}`
    );
  } catch {
    return false;
  }
}
