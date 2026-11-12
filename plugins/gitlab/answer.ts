import type { Job } from "../../protocol/job.ts";
const options = ["发布这份报告中的评论", "不发布"];
export function publishDecision(answer: Job["context"]["answers"][number], manifestHash: string): 0 | 1 | null {
  if (
    !/^[a-f0-9]{64}$/.test(manifestHash) ||
    answer.options.length !== 2 ||
    !(
      answer.options[1] === options[1] &&
      (answer.options[0] === options[0] || /^发布 [1-9]\d* 条评论$/.test(answer.options[0]))
    ) ||
    (answer.choice !== 0 && answer.choice !== 1) ||
    answer.text !== null
  )
    return null;
  try {
    const about: unknown = JSON.parse(answer.about);
    if (!about || typeof about !== "object" || Array.isArray(about)) return null;
    const data = about as Record<string, unknown>;
    if (
      Object.keys(data).sort().join(",") !== "kind,manifestHash,schema" ||
      data.schema !== 1 ||
      data.kind !== "publish" ||
      data.manifestHash !== manifestHash
    )
      return null;
    return answer.choice;
  } catch {
    return null;
  }
}
