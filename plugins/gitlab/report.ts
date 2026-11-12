export type Finding = {
  severity: "P0" | "P1" | "P2" | "P3";
  title: string;
  evidence: string;
  impact: string;
  suggestion: string;
  path: string;
  side: "old" | "new";
  line: number | null;
};
export type ModelReport = { complete: true; executionIssue: ""; findings: Finding[] };
export class ModelIncompleteError extends Error {}

function object(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === keys.sort().join("\0")
  );
}
function string(value: unknown, max: number): value is string {
  return typeof value === "string" && !!value.trim() && [...value].length <= max;
}
function finding(value: unknown): value is Finding {
  if (!object(value, ["severity", "title", "evidence", "impact", "suggestion", "path", "side", "line"])) return false;
  return (
    ["P0", "P1", "P2", "P3"].includes(value.severity as string) &&
    string(value.title, 200) &&
    string(value.evidence, 3000) &&
    string(value.impact, 3000) &&
    string(value.suggestion, 3000) &&
    string(value.path, 3000) &&
    !value.path.startsWith("/") &&
    !value.path.includes("\\") &&
    !value.path.split("/").some((part) => part === ".." || part === "") &&
    (value.side === "old" || value.side === "new") &&
    (value.line === null || (Number.isSafeInteger(value.line) && (value.line as number) > 0))
  );
}
export function parseModelReport(text: string): ModelReport {
  if (Buffer.byteLength(text, "utf8") > 1024 * 1024) throw new Error("报告超过大小限制");
  const value: unknown = JSON.parse(text);
  if (
    object(value, ["complete", "executionIssue", "findings"]) &&
    value.complete === false &&
    string(value.executionIssue, 1000)
  )
    throw new ModelIncompleteError(value.executionIssue.replace(/[\x00-\x1f\x7f]/g, " "));
  if (
    !object(value, ["complete", "executionIssue", "findings"]) ||
    typeof value.executionIssue !== "string" ||
    [...value.executionIssue].length > 1000 ||
    value.complete !== true ||
    !Array.isArray(value.findings) ||
    value.findings.length > 100 ||
    !value.findings.every(finding)
  )
    throw new Error("报告格式不符合要求");
  return { complete: true, executionIssue: "", findings: value.findings as Finding[] };
}

export const modelReportSchema = {
  type: "object",
  additionalProperties: false,
  required: ["complete", "executionIssue", "findings"],
  properties: {
    complete: { type: "boolean" },
    executionIssue: {
      type: "string",
      maxLength: 1000,
      description: "Only describe an execution failure when complete is false; otherwise leave empty.",
    },
    findings: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "title", "evidence", "impact", "suggestion", "path", "side", "line"],
        properties: {
          severity: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
          title: { type: "string", minLength: 1, maxLength: 200 },
          evidence: { type: "string", minLength: 1, maxLength: 3000 },
          impact: { type: "string", minLength: 1, maxLength: 3000 },
          suggestion: { type: "string", minLength: 1, maxLength: 3000 },
          path: { type: "string", minLength: 1, maxLength: 3000 },
          side: { type: "string", enum: ["old", "new"] },
          line: { anyOf: [{ type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, { type: "null" }] },
        },
      },
    },
  },
} as const;
