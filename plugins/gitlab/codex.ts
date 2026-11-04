export function codexArgs(model: string, effort: string | undefined, output: string, schema?: string): string[] {
  if (!model.trim() || (effort !== undefined && !/^[a-z]+$/.test(effort))) throw new Error("模型配置无效");
  return [
    "exec",
    "-m",
    model,
    ...(effort ? ["-c", `model_reasoning_effort=${JSON.stringify(effort)}`] : []),
    "--json",
    ...(schema ? ["--output-schema", schema] : []),
    "-o",
    output,
    "-",
  ];
}
export function completed(text: string): boolean {
  try {
    const events = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    return (
      events.length > 0 &&
      events.at(-1)?.type === "turn.completed" &&
      !events.some((e) => e.type === "turn.failed" || e.type === "error")
    );
  } catch {
    return false;
  }
}

export async function runCodex(
  program: string,
  cwd: string,
  model: string,
  effort: string | undefined,
  prompt: string,
  diagnosticsRoot?: string,
  artifactDir?: string,
) {
  const { spawn } = await import("node:child_process");
  const { readFileSync, unlinkSync, writeFileSync, mkdirSync, mkdtempSync, copyFileSync, chmodSync } =
    await import("node:fs");
  const { join, basename } = await import("node:path");
  const output = join(artifactDir ?? cwd, "codex-output.json");
  const schemaPath = join(artifactDir ?? cwd, "model-report-schema.json");
  const { modelReportSchema, parseModelReport, ModelIncompleteError } = await import("./report.ts");
  writeFileSync(schemaPath, JSON.stringify(modelReportSchema), { mode: 0o400 });
  try {
    unlinkSync(output);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const startedAt = new Date().toISOString();
  const child = spawn(program, codexArgs(model, effort, output, schemaPath), {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);
  let events = "",
    tooLarge = false;
  child.stdout.on("data", (chunk) => {
    events += chunk;
    if (events.length > 8 * 1024 * 1024) {
      tooLarge = true;
      child.kill();
    }
  });
  child.stderr.resume();
  let report: ReturnType<typeof parseModelReport> | undefined;
  let exitCode: number | null = null;
  let failure: string | null = null;
  let issue: string | null = null;
  try {
    exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    if (tooLarge) failure = "event_stream_too_large";
    else if (exitCode !== 0) failure = "process_exit";
    else if (!completed(events)) failure = "incomplete_event_stream";
    else {
      try {
        const text = readFileSync(output, "utf8");
        try {
          report = parseModelReport(text);
        } catch (error) {
          if (error instanceof ModelIncompleteError) {
            failure = "model_incomplete";
            issue = error.message;
          } else failure = "invalid_output";
        }
      } catch {
        failure = "missing_output";
      }
    }
  } catch {
    failure = "spawn_error";
  }
  const finishedAt = new Date().toISOString();
  const parent = diagnosticsRoot ?? join(cwd, "diagnostics");
  let directory: string;
  try {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    directory = mkdtempSync(join(parent, "codex-"));
    writeFileSync(join(directory, "prompt.txt"), prompt, { mode: 0o600 });
    writeFileSync(join(directory, "schema.json"), JSON.stringify(modelReportSchema), { mode: 0o600 });
    writeFileSync(join(directory, "stdout.jsonl"), events, { mode: 0o600 });
    writeFileSync(
      join(directory, "metadata.json"),
      JSON.stringify({ model, effort: effort ?? null, success: !!report, failure, exitCode, startedAt, finishedAt }),
      { mode: 0o600 },
    );
    try {
      copyFileSync(output, join(directory, "output.json"));
      chmodSync(join(directory, "output.json"), 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  } catch {
    throw new Error("Codex 审查结果无法保存审计记录");
  }
  if (!report) throw new Error(`Codex 审查结果无效或未完成${issue ? `：${issue}` : ""}，诊断保存在 ${directory}`);
  return { report, audit: basename(directory) };
}
