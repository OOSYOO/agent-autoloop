import type { Project } from "./config.ts";
export type Override = "reviewer" | "draft" | "ci";

export function isTerminalMR(mr: any): boolean {
  return mr?.state === "merged" || mr?.state === "closed";
}

export function eligible(mr: any, reviewerId: number, _ciMode: Project["ciMode"], overrides: Override[]): boolean {
  if (
    !mr ||
    mr.state !== "opened" ||
    typeof mr.draft !== "boolean" ||
    !/^[a-f0-9]{40}$/.test(mr.sha) ||
    !Array.isArray(mr.reviewers)
  )
    return false;
  if (mr.draft && !overrides.includes("draft")) return false;
  if (!mr.reviewers.some((r: any) => r?.id === reviewerId) && !overrides.includes("reviewer")) return false;
  return true;
}

// Keep the shared entry point so scan, execution and publication enforce the same MR checks.
export async function eligibleForReview(
  _gl: Pick<import("./api.ts").GitLab, "get" | "list">,
  project: Pick<Project, "id" | "ciMode" | "ciJobs" | "ciBridges">,
  mr: any,
  reviewerId: number,
  overrides: Override[],
): Promise<boolean> {
  return eligible(mr, reviewerId, project.ciMode, overrides);
}
