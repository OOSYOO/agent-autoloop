import type { Finding } from "./report.ts";

type Item = { body: string; position: { old_path?: string; new_path?: string; old_line?: number; new_line?: number } };
export function findingsPages(
  url: string,
  sha: string,
  reportHash: string,
  projectId: number,
  mrIid: number,
  policy: string,
  findings: Finding[],
  items: Item[],
): string[] {
  const header = `MR ${projectId}/${mrIid}，版本 ${sha}，策略 ${policy}，\nMR：${url}\n版本：${sha}\n报告：${reportHash}\n`;
  const descriptions = findings
    .map((f, i) => {
      const body = `[${f.severity}] ${f.title}\n\n${f.evidence}\n\n影响：${f.impact}\n\n建议：${f.suggestion}`;
      const publishable = items.some(
        (item) =>
          item.body === body &&
          (f.side === "new"
            ? item.position.new_path === f.path && item.position.new_line === f.line
            : item.position.old_path === f.path && item.position.old_line === f.line),
      );
      return `\n${i + 1}. ${publishable ? "将发布" : "不发布"}｜${f.path} ${f.side === "new" ? "新" : "旧"}版本${f.line === null ? "（无行号）" : `第 ${f.line} 行`}\n${body}\n`;
    })
    .join("");
  const source = [...descriptions];
  const limit = 3800 - [...header].length;
  if (limit <= 0 || source.length > limit * 10)
    throw new Error("findings 超出飞书可完整展示的容量，未创建发布确认，也未发布评论。");
  const chunks: string[] = [];
  while (source.length) chunks.push(source.splice(0, limit).join(""));
  return chunks.map((chunk, i) => `${header}findings ${i + 1}/${chunks.length}\n${chunk}`);
}
