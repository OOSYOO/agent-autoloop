import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { createRequire } from "node:module";
import { canonical, hash } from "./storage.ts";
export type Project = {
  id: number;
  projectPath?: string;
  rulesBranch?: string;
  publication: "manual" | "auto" | "severity";
  ciMode: "required" | "confirmed-none" | "allow-skipped" | "checks";
  ciJobs?: string[];
  ciBridges?: string[];
  cachePath: string;
};
export type Config = {
  schema: 1;
  instanceKey: string;
  instanceUrl: string;
  trustedHttpOrigin?: string;
  reviewerId: number;
  hubUrl: string;
  sourceKeyPath: string;
  dataRoot: string;
  model: string;
  effort?: string;
  codexPath: string;
  glabPath: string;
  projects: Project[];
};
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const path = (v: unknown): v is string => typeof v === "string" && isAbsolute(v);
export function parseConfig(value: unknown, baseDir?: string): Config {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("配置不符合要求");
  let v = value as Record<string, any>;
  if (v.skill !== undefined || v.skillPath !== undefined)
    throw new Error("GitLab 不再支持 skill/skillPath/rules；请在 rules.prompt 指定审查要求");
  if (baseDir !== undefined) {
    if (!isAbsolute(baseDir)) throw new Error("配置目录必须是绝对路径");
    const local = (item: unknown): unknown =>
      typeof item === "string" && item.length > 0 ? resolve(baseDir, item) : item;
    const executable = (item: unknown): unknown => {
      if (typeof item !== "string" || !item) return item;
      if (isAbsolute(item)) return item;
      if (item.includes("/")) return resolve(baseDir, item);
      if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.+-]*$/.test(item)) throw new Error("程序名称无效");
      const { findProgram } = createRequire(import.meta.url)(
        "../../worker/agents.ts",
      ) as typeof import("../../worker/agents.ts");
      return findProgram(item);
    };
    v = {
      ...v,
      sourceKeyPath: local(v.sourceKeyPath),
      dataRoot: local(v.dataRoot),
      codexPath: executable(v.codexPath),
      glabPath: executable(v.glabPath),
      projects: Array.isArray(v.projects)
        ? v.projects.map((project: any) =>
            project && typeof project === "object" ? { ...project, cachePath: local(project.cachePath) } : project,
          )
        : v.projects,
    };
  }
  if (
    !v ||
    v.schema !== 1 ||
    typeof v.instanceKey !== "string" ||
    !/^[a-z][a-z0-9-]{0,15}$/.test(v.instanceKey) ||
    !positive(v.reviewerId) ||
    !path(v.sourceKeyPath) ||
    !path(v.dataRoot) ||
    !path(v.codexPath) ||
    !path(v.glabPath) ||
    typeof v.model !== "string" ||
    !v.model.trim() ||
    (v.effort !== undefined && (typeof v.effort !== "string" || !v.effort.trim())) ||
    !Array.isArray(v.projects) ||
    !v.projects.length
  )
    throw new Error("配置不符合要求");
  let instance: URL, hub: URL;
  try {
    instance = new URL(v.instanceUrl);
    hub = new URL(v.hubUrl);
  } catch {
    throw new Error("地址无效");
  }
  if (
    (instance.protocol !== "https:" && !(instance.protocol === "http:" && v.trustedHttpOrigin === instance.origin)) ||
    (v.trustedHttpOrigin !== undefined && v.trustedHttpOrigin !== instance.origin) ||
    instance.origin !== v.instanceUrl ||
    instance.username ||
    instance.password ||
    !["http:", "https:"].includes(hub.protocol) ||
    hub.origin !== v.hubUrl ||
    hub.username ||
    hub.password
  )
    throw new Error("地址不符合要求");
  const ids = new Set<number>();
  const projects = v.projects.map((p: any): Project => {
    if (p && (p.skill !== undefined || p.skillPath !== undefined || p.rules !== undefined))
      throw new Error("GitLab 不再支持 skill/skillPath/rules；请在 rules.prompt 指定审查要求");
    if (
      !p ||
      !positive(p.id) ||
      ids.has(p.id) ||
      !path(p.cachePath) ||
      ![undefined, "manual", "auto", "severity"].includes(p.publication) ||
      ![undefined, "required", "confirmed-none", "allow-skipped", "checks"].includes(p.ciMode)
    )
      throw new Error("项目配置无效");
    const names = (value: unknown): value is string[] =>
      Array.isArray(value) &&
      value.every((name) => typeof name === "string" && name.trim() === name && name.length > 0) &&
      new Set(value).size === value.length;
    if (p.ciMode === "checks") {
      if (!names(p.ciJobs) || !p.ciJobs.length || (p.ciBridges !== undefined && !names(p.ciBridges)))
        throw new Error("checks 模式需要非空且不重复的 ciJobs，ciBridges 也不得重复");
    } else if (p.ciJobs !== undefined || p.ciBridges !== undefined)
      throw new Error("ciJobs/ciBridges 只用于 checks 模式");
    if (
      p.projectPath !== undefined &&
      (typeof p.projectPath !== "string" ||
        !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+$/.test(p.projectPath) ||
        p.projectPath.split("/").some((part: string) => part === "." || part === ".."))
    )
      throw new Error("项目路径无效");
    if (
      p.rulesBranch !== undefined &&
      (typeof p.rulesBranch !== "string" || !p.rulesBranch || p.rulesBranch.startsWith("-"))
    )
      throw new Error("可信分支无效");
    ids.add(p.id);
    return {
      ...(p.projectPath === undefined ? {} : { projectPath: p.projectPath }),
      ...(p.rulesBranch === undefined ? {} : { rulesBranch: p.rulesBranch }),
      id: p.id,
      cachePath: p.cachePath,
      publication: p.publication ?? "manual",
      ciMode: p.ciMode ?? "required",
      ...(p.ciMode === "checks" ? { ciJobs: p.ciJobs, ciBridges: p.ciBridges ?? [] } : {}),
    };
  });
  return {
    schema: 1,
    instanceKey: v.instanceKey,
    instanceUrl: v.instanceUrl,
    ...(v.trustedHttpOrigin === undefined ? {} : { trustedHttpOrigin: v.trustedHttpOrigin }),
    reviewerId: v.reviewerId,
    hubUrl: v.hubUrl,
    sourceKeyPath: v.sourceKeyPath,
    dataRoot: v.dataRoot,
    model: v.model,
    ...(v.effort === undefined ? {} : { effort: v.effort }),
    codexPath: v.codexPath,
    glabPath: v.glabPath,
    projects,
  };
}
export function loadConfig(configFile: string): Config {
  const file = resolve(configFile);
  return parseConfig(JSON.parse(readFileSync(file, "utf8")), dirname(file));
}
export function policyHash(config: Config, project: Project, instructionsDigest: string, rulesDigest?: string): string {
  return hash(
    canonical({
      reviewPolicy: "native-mr-url-v5",
      instanceKey: config.instanceKey,
      instanceUrl: config.instanceUrl,
      trustedHttpOrigin: config.trustedHttpOrigin ?? null,
      reviewerId: config.reviewerId,
      projectId: project.id,
      projectPath: project.projectPath ?? null,
      rulesDigest: rulesDigest ?? null,
      publication: project.publication,
      model: config.model,
      effort: config.effort ?? null,
      instructionsDigest,
    }),
  );
}
