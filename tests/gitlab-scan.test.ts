// Failure modes: dropped hub responses cause new event IDs or unrouted events count as successful dispatch.
import assert from "node:assert/strict";
import { test } from "node:test";
import { scanProject } from "../plugins/gitlab/scan.ts";
const sha = "a".repeat(40),
  policy = "b".repeat(64);
test("persists before posting and retries with stable ID", async () => {
  const records: any[] = [];
  const posted: any[] = [];
  const io = {
    list: async () => [
      { iid: 1, state: "opened", draft: false, sha, reviewers: [{ id: 8 }], head_pipeline: { sha, status: "success" } },
    ],
    read: () => records.at(-1),
    write: (r: any) => records.push(r),
    post: async (e: any) => {
      posted.push(e);
      if (posted.length === 1) throw Error("lost");
      return { event: 1, duplicate: true, routed: ["review"] };
    },
  };
  const config = { instanceKey: "work", instanceUrl: "https://gitlab.example.com", reviewerId: 8 };
  const project = { id: 42, ciMode: "required" as const };
  await assert.rejects(scanProject(config, project, "team/project", policy, io));
  await scanProject(config, project, "team/project", policy, io);
  assert.equal(posted[0].id, posted[1].id);
  assert.equal(records.at(-1).delivered, true);
});

test("unrouted record is retried only as a new observation after repair", async () => {
  const records: any[] = [];
  const posted: any[] = [];
  let routed = false;
  const io = {
    list: async () => [
      { iid: 1, state: "opened", draft: false, sha, reviewers: [{ id: 8 }], head_pipeline: { sha, status: "success" } },
    ],
    read: () => records.at(-1),
    write: (r: any) => records.push(r),
    post: async (e: any) => {
      posted.push(e);
      return { event: 1, duplicate: false, routed: routed ? ["review"] : [] };
    },
  };
  const config = { instanceKey: "work", instanceUrl: "https://gitlab.example.com", reviewerId: 8 };
  const project = { id: 42, ciMode: "required" as const };
  await assert.rejects(scanProject(config, project, "team/project", policy, io));
  routed = true;
  await scanProject(config, project, "team/project", policy, { ...io, retryUnrouted: true });
  assert.notEqual(posted[0].id, posted[1].id);
});

test("automatic scan does not redispatch a delivered manual request", async () => {
  const records: any[] = [
    {
      schema: 1,
      instanceKey: "work",
      projectId: 42,
      mrIid: 1,
      headSha: sha,
      policyHash: policy,
      eligible: true,
      observation: 1,
      requestId: "d".repeat(64),
      origin: "manual",
      delivered: true,
    },
  ];
  const posted: any[] = [];
  const io = {
    list: async () => [
      { iid: 1, state: "opened", draft: false, sha, reviewers: [{ id: 8 }], head_pipeline: { sha, status: "success" } },
    ],
    read: () => records.at(-1),
    write: (r: any) => records.push(r),
    post: async (e: any) => {
      posted.push(e);
      return { event: 1, duplicate: false, routed: ["review"] };
    },
  };
  await scanProject(
    { instanceKey: "work", instanceUrl: "https://gitlab.example.com", reviewerId: 8 },
    { id: 42, ciMode: "required" },
    "team/project",
    policy,
    io,
  );
  assert.equal(posted.length, 0);
});

test("delivered manual review is reused unless its head changes", async () => {
  const base = {
    schema: 1,
    instanceKey: "work",
    projectId: 42,
    mrIid: 1,
    headSha: sha,
    policyHash: policy,
    eligible: true,
    observation: 1,
    requestId: "d".repeat(64),
    origin: "manual",
    delivered: true,
    overrides: [],
  };
  for (const variant of ["same", "override", "head", "policy", "ineligible"] as const) {
    const records: any[] = [{ ...base, overrides: variant === "override" ? ["ci"] : [] }];
    const posted: any[] = [];
    const head = variant === "head" ? "c".repeat(40) : sha;
    await scanProject(
      { instanceKey: "work", instanceUrl: "https://gitlab.example.com", reviewerId: 8 },
      { id: 42, ciMode: "required" },
      "team/project",
      variant === "policy" ? "e".repeat(64) : policy,
      {
        list: async () => [
          {
            iid: 1,
            state: "opened",
            draft: false,
            sha: head,
            reviewers: variant === "ineligible" ? [] : [{ id: 8 }],
            head_pipeline: { sha: head, status: "success" },
          },
        ],
        read: () => records.at(-1),
        write: (record: any) => records.push(record),
        post: async (event: any) => {
          posted.push(event);
          return { event: 1, duplicate: false, routed: ["review"] };
        },
      },
    );
    if (variant !== "head") {
      assert.equal(records.length, 1);
      assert.equal(posted.length, 0);
    } else {
      assert.notEqual(records.at(-1).requestId, base.requestId);
      assert.equal(posted.length, 1);
      if (posted.length) assert.equal(JSON.parse(posted[0].detail).overrides, undefined);
    }
  }
});

test("multiple matching review rules are not accepted as one dispatch", async () => {
  const records: any[] = [];
  const io = {
    list: async () => [
      { iid: 1, state: "opened", draft: false, sha, reviewers: [{ id: 8 }], head_pipeline: { sha, status: "success" } },
    ],
    read: () => records.at(-1),
    write: (r: any) => records.push(r),
    post: async () => ({ event: 1, duplicate: false, routed: ["one", "two"] }),
  };
  await assert.rejects(
    scanProject(
      { instanceKey: "work", instanceUrl: "https://gitlab.example.com", reviewerId: 8 },
      { id: 42, ciMode: "required" },
      "team/project",
      policy,
      io,
    ),
  );
  assert.notEqual(records.at(-1).delivered, true);
});

test("reviewer removal then reassignment at the same SHA does not dispatch again", async () => {
  const records: any[] = [];
  const posted: any[] = [];
  let assigned = true;
  const io = {
    list: async () => [
      {
        iid: 1,
        state: "opened",
        draft: false,
        sha,
        reviewers: assigned ? [{ id: 8 }] : [],
        head_pipeline: { sha, status: "success" },
      },
    ],
    read: () => records.at(-1),
    write: (r: any) => records.push(r),
    post: async (e: any) => {
      posted.push(e);
      return { event: 1, duplicate: false, routed: ["review"] };
    },
  };
  const config = { instanceKey: "work", instanceUrl: "https://gitlab.example.com", reviewerId: 8 };
  const project = { id: 42, ciMode: "required" as const };
  await scanProject(config, project, "team/project", policy, io);
  assigned = false;
  await scanProject(config, project, "team/project", policy, io);
  assigned = true;
  await scanProject(config, project, "team/project", policy, io);
  assert.equal(posted.length, 1);
  assert.equal(records.at(-1).observation, 1);
});

test("CI cannot block initial dispatch or redispatch the delivered head", async () => {
  const { eligibleForReview } = await import("../plugins/gitlab/ci.ts");
  const mr = {
    iid: 7,
    state: "opened",
    draft: false,
    sha,
    reviewers: [{ id: 8 }],
    head_pipeline: { id: 10, sha, status: "canceled" },
  };
  const project = { id: 42, ciMode: "checks" as const, ciJobs: ["host"] };
  const config = { instanceKey: "work", instanceUrl: "https://gitlab.example.com", reviewerId: 8 };
  const posted: object[] = [],
    records: any[] = [];
  let status = "failed";
  const gl = {
    get: async () => mr,
    list: async () => [{ id: 1, name: "host", status, commit: { id: sha }, pipeline: { id: 10 } }],
  };
  const io = {
    list: async () => [mr],
    read: () => records.at(-1),
    write: (record: any) => {
      records.push(record);
    },
    eligible: (current: any) => eligibleForReview(gl, project, current, 8, []),
    post: async (event: object) => {
      posted.push(event);
      return { event: 1, duplicate: false, routed: ["review"] };
    },
  };
  await scanProject(config, project, "team/project", policy, io);
  assert.equal(posted.length, 1);
  status = "failed";
  await scanProject(config, project, "team/project", policy, io);
  assert.equal(records.at(-1).eligible, true);
  assert.equal(posted.length, 1);
  mr.head_pipeline.status = "success";
  await scanProject(config, project, "team/project", policy, { ...io, eligible: undefined });
  assert.equal(records.at(-1).eligible, true, "the delivered observation remains unchanged");
});

test("delivered head is not dispatched again after policy or eligibility changes", async () => {
  const records: any[] = [],
    posted: any[] = [];
  let assigned = true;
  const io = {
    list: async () => [
      {
        iid: 1,
        state: "opened",
        draft: false,
        sha,
        reviewers: assigned ? [{ id: 8 }] : [],
        head_pipeline: { sha, status: "success" },
      },
    ],
    read: () => records.at(-1),
    write: (r: any) => records.push(r),
    post: async (e: any) => {
      posted.push(e);
      return { event: 1, duplicate: false, routed: ["review"] };
    },
  };
  const config = { instanceKey: "work", instanceUrl: "https://gitlab.example.com", reviewerId: 8 },
    project = { id: 42, ciMode: "required" as const };
  await scanProject(config, project, "team/project", policy, io);
  assigned = false;
  await scanProject(config, project, "team/project", "e".repeat(64), io);
  assigned = true;
  await scanProject(config, project, "team/project", "e".repeat(64), io);
  assert.equal(posted.length, 1);
});

test("lost response retries the same delivered identity despite policy and eligibility changes", async () => {
  const records: any[] = [],
    events: any[] = [];
  let assigned = true;
  const io = {
    list: async () => [
      {
        iid: 1,
        state: "opened",
        draft: false,
        sha,
        reviewers: assigned ? [{ id: 8 }] : [],
        head_pipeline: { sha, status: "success" },
      },
    ],
    read: () => records.at(-1),
    write: (v: any) => records.push(v),
    post: async (v: any) => {
      events.push(v);
      if (events.length === 1) throw Error("lost");
      return { event: 1, duplicate: true, routed: ["review"] };
    },
  };
  const config = { instanceKey: "work", instanceUrl: "https://gitlab.example.com", reviewerId: 8 },
    project = { id: 42, ciMode: "required" as const };
  await assert.rejects(scanProject(config, project, "team/project", policy, io));
  assigned = false;
  await scanProject(config, project, "team/project", "e".repeat(64), io);
  assigned = true;
  await scanProject(config, project, "team/project", "e".repeat(64), io);
  assert.equal(events.length, 2);
  assert.equal(events[0].id, events[1].id);
  assert.equal(events[0].detail, events[1].detail);
});
