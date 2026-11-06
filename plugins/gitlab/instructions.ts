import { resolve } from "node:path";
import { typeMatches } from "../../kernel/rules.ts";

type Routing = {
  agents: Record<string, { use?: string; command?: string[] }>;
  rules: { name: string; when: { source?: string; types?: string[] }; to: string; prompt?: string; skill?: string }[];
};

export function instructionsFromRules(rules: Routing, projectId: number, configFile: string, home: string): string {
  const matches = rules.rules.filter(
    (rule) => rule.when.source === "gitlab" && typeMatches(rule.when.types ?? [], `mr.review.${projectId}`),
  );
  if (matches.length !== 1) throw new Error(`项目 ${projectId} 必须恰好匹配一条审查规则`);
  const rule = matches[0];
  if (rule.skill !== undefined) throw new Error(`项目 ${projectId} 禁用 rule.skill，请在 prompt 指定 Skill`);
  const agent = rules.agents[rule.to];
  const command = agent?.command;
  if (
    agent?.use !== "gitlab" ||
    command?.length !== 3 ||
    command[0] !== "review" ||
    command[1] !== "--config" ||
    resolve(home, command[2]) !== resolve(configFile)
  )
    throw new Error(`项目 ${projectId} 的审查规则与 GitLab 配置不一致`);
  if (typeof rule.prompt !== "string" || !rule.prompt.trim())
    throw new Error(`项目 ${projectId} 的审查规则必须填写 prompt`);
  return rule.prompt;
}

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hash } from "./storage.ts";

export function loadInstructions(
  configFile: string,
  projectId: number,
  home: string,
  rulesFile = join(home, "rules.json"),
) {
  const rules = JSON.parse(readFileSync(rulesFile, "utf8"));
  const prompt = instructionsFromRules(rules, projectId, configFile, home);
  const match = rules.rules.find(
    (rule: any) => rule.when?.source === "gitlab" && typeMatches(rule.when.types ?? [], `mr.review.${projectId}`),
  );
  return { prompt, digest: hash(prompt), ruleName: match.name };
}

export function jobInstructions(contextFile: string) {
  const entry = JSON.parse(readFileSync(join(dirname(contextFile), "entry.json"), "utf8"));
  const rule = entry.job?.rule;
  if (
    !rule ||
    typeof rule.name !== "string" ||
    !rule.name.trim() ||
    typeof rule.prompt !== "string" ||
    !rule.prompt.trim() ||
    rule.skill !== undefined
  )
    throw new Error("运行规则缺少可信审查 prompt");
  return { prompt: rule.prompt, digest: hash(rule.prompt), ruleName: rule.name };
}
