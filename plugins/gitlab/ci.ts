import type { Project } from "./config.ts";
export type Override = "reviewer" | "draft" | "ci";

export function eligible(mr: any, reviewerId: number, ciMode: Project["ciMode"], overrides: Override[]): boolean {
  if (
    !mr ||
    mr.state !== "opened" ||
    typeof mr.draft !== "boolean" ||
    !/^[a-f0-9]{40}$/.test(mr.sha) ||
    !Array.isArray(mr.reviewers) ||
    !("head_pipeline" in mr)
  )
    return false;
  if (mr.draft && !overrides.includes("draft")) return false;
  if (!mr.reviewers.some((r: any) => r?.id === reviewerId) && !overrides.includes("reviewer")) return false;
  if (!overrides.includes("ci")) {
    if (ciMode === "checks") return false;
    if (mr.head_pipeline === null) return ciMode === "confirmed-none";
    if (!mr.head_pipeline || mr.head_pipeline.sha !== mr.sha) return false;
    if (mr.head_pipeline.status !== "success" && !(ciMode === "allow-skipped" && mr.head_pipeline.status === "skipped"))
      return false;
  }
  return true;
}

/** Read current checks in one project; approval jobs outside the configured gate do not decide review readiness. */
export async function eligibleForReview(
  gl: Pick<import("./api.ts").GitLab, "get" | "list">,
  project: Pick<Project, "id" | "ciMode" | "ciJobs" | "ciBridges">,
  mr: any,
  reviewerId: number,
  overrides: Override[],
): Promise<boolean> {
  if (project.ciMode !== "checks" || overrides.includes("ci"))
    return eligible(mr, reviewerId, project.ciMode, overrides);
  if (!eligible(mr, reviewerId, project.ciMode, [...overrides, "ci"])) return false;
  const pipeline = mr.head_pipeline;
  if (
    !Number.isSafeInteger(mr.iid) ||
    mr.iid <= 0 ||
    !Number.isSafeInteger(pipeline?.id) ||
    pipeline.id <= 0 ||
    pipeline.sha !== mr.sha ||
    !project.ciJobs?.length
  )
    return false;
  const prefix = `projects/${project.id}/pipelines/${pipeline.id}`;
  const jobs = await gl.list(`${prefix}/jobs?include_retried=false&per_page=100`);
  const successful = (item: any) =>
    item?.status === "success" && item.commit?.id === mr.sha && item.pipeline?.id === pipeline.id;
  for (const name of project.ciJobs) {
    const matches = jobs.filter((item: any) => item?.name === name);
    if (matches.length !== 1 || !successful(matches[0])) return false;
  }
  if (project.ciBridges?.length) {
    const bridges = await gl.list(`${prefix}/bridges?per_page=100`);
    for (const name of project.ciBridges) {
      const matches = bridges.filter((item: any) => item?.name === name) as any[];
      if (matches.length !== 1 || !successful(matches[0])) return false;
      const child = matches[0].downstream_pipeline;
      if (!Number.isSafeInteger(child?.id) || child.id <= 0 || child.project_id !== project.id || child.sha !== mr.sha)
        return false;
      const current: any = await gl.get(`projects/${project.id}/pipelines/${child.id}`);
      if (
        current?.id !== child.id ||
        current.project_id !== project.id ||
        current.sha !== mr.sha ||
        current.status !== "success"
      )
        return false;
    }
  }
  const latest: any = await gl.get(`projects/${project.id}/merge_requests/${mr.iid}`);
  return (
    eligible(latest, reviewerId, project.ciMode, [...overrides, "ci"]) &&
    latest.sha === mr.sha &&
    latest.head_pipeline?.id === pipeline.id &&
    latest.head_pipeline?.sha === mr.sha
  );
}
