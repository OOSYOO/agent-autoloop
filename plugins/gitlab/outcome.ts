export function answerOutcome(outcomes: string[]): string | null {
  if (outcomes.includes("unknown")) return "评论发送结果未确认，请在 GitLab 核查；系统不会自动重发。";
  if (outcomes.includes("sent-stale")) return "评论已发到旧版本，请在 GitLab 核查。";
  if (outcomes.includes("stale")) return "版本或策略已变化，未发布评论。";
  if (outcomes.includes("sent")) return "审查评论已发布。";
  if (outcomes.includes("rejected")) return "已按你的决定不发布。";
  return null;
}
