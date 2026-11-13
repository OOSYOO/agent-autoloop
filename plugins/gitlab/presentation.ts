import type { Finding } from "./report.ts";

type Item = {
  body: string;
  position: { old_path?: string; new_path?: string; old_line?: number; new_line?: number } | null;
};
type ReviewContext = { projectPath: string; mrIid: number; title: string };
export function findingsPages(url: string, findings: Finding[], items: Item[], context?: ReviewContext): string[] {
  const header = reviewSummary(url, findings, items.length, context);
  if (!findings.length) return [header];
  const descriptions = findings
    .map((f, i) => {
      const body = `[${f.severity}] ${f.title}\n\n${f.evidence}\n\n影响：${f.impact}\n\n建议：${f.suggestion}`;
      const publishable = items.some(
        (item) =>
          (item.position === null &&
            item.body ===
              `[${f.severity}] ${f.title}\n\n位置：${f.path}（${f.side === "new" ? "新" : "旧"}版本${f.line === null ? "，无行号" : `第 ${f.line} 行`}）\n\n${f.evidence}\n\n影响：${f.impact}\n\n建议：${f.suggestion}`) ||
          (item.body === body &&
            item.position !== null &&
            (f.side === "new"
              ? item.position.new_path === f.path && item.position.new_line === f.line
              : item.position.old_path === f.path && item.position.old_line === f.line)),
      );
      return `\n${i + 1}. ${publishable ? "将发布" : "不发布"}｜${f.path} ${f.side === "new" ? "新" : "旧"}版本${f.line === null ? "（无行号）" : `第 ${f.line} 行`}\n${body}\n`;
    })
    .join("");
  const source = [...descriptions];
  const limit = 3800 - [...header].length - 40;
  if (limit <= 0 || source.length > limit * 10)
    throw new Error("完整报告超出飞书可展示的容量，未创建发布确认，也未发布评论。");
  const chunks: string[] = [];
  while (source.length) chunks.push(source.splice(0, limit).join(""));
  return chunks.map(
    (chunk, i) =>
      `${header}${chunks.length > 1 ? `\n完整报告第 ${i + 1}/${chunks.length} 页` : ""}\n\n完整报告：\n${chunk}`,
  );
}

export function reviewSummary(url: string, findings: Finding[], count: number, context?: ReviewContext): string {
  const identity = context
    ? `仓库：${context.projectPath}\nMR：!${context.mrIid}\nMR 标题：${context.title.replace(/\s+/g, " ").trim() || "未提供标题"}\n${url}`
    : url;
  if (!findings.length) return `${identity}\n\n未发现问题，仍需人工审核。`;
  const short = (text: string, limit: number) => {
    const line = text.replace(/\s+/g, " ").trim();
    const chars = [...line];
    return chars.length > limit ? chars.slice(0, limit).join("") + "…" : line;
  };
  const preview = findings
    .slice(0, 5)
    .map(
      (f) =>
        `[${f.severity}${f.severity === "P3" ? " · 仅供参考" : ""}] ${short(f.title, 70)}\n${short(f.impact, 100)}\n建议：${short(f.suggestion, 100)}`,
    )
    .join("\n\n");
  return `${identity}\n\n${preview}${findings.length > 5 ? `\n\n另有 ${findings.length - 5} 条问题，见完整报告。` : ""}\n\n${count ? `确认后，将在这条 MR 下发布 ${count} 条问题的完整评论。` : "以下问题仅供参考，无需确认发布。"}`;
}
