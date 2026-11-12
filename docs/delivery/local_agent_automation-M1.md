# GitLab Review 取消 CI 门槛 · M1 交付记录

- 范围：[交付计划](../plans/local_agent_automation.md) M1；[技术方案](../specs/local_agent_automation.md#取消-gitlab-review-的-ci-门槛) CI-01 至 CI-05 及保留授权边界。
- 授权：用户要求持续执行，仅负责最后验收。实现、测试、独立审查、提交、功能分支推送及 PR/CI 收尾已授权；不合并、不部署。
- 起始 HEAD：`eec99debfd3af86df408b21b1b57600afde59416`；当前分支 `codex/remote-review-worker`，最终目标 `origin/main`。
- 工作区归属：已有未提交远程 Worker 工作树整理、飞书入口、看板方案及文档改动。本任务保留所有改动；仅精确暂存本任务内容及不可缺少的飞书入口依赖。已有已提交历史在累计 PR 审查中单列，不声称是本轮新增。
- 状态：本地验收与 M1 独立审查通过，正在精确提交及最终 PR 收尾。
- 本地证据：`/tmp/review-ci-baseline.log`；集成基线 `/tmp/review-ci-integration-baseline.log`；失败复现 `/tmp/review-ci-red.log`。均为当前主机临时日志，最终证据会汇总在本文，不依赖日志永久存在。
- 审查轮次：M1 1/3，findings=[]；最终累计 0/3。CI 修复轮次 0/3。
- 下一动作：提交本任务、完成相对 origin/main 的累计独立审查、推送并创建 PR，核对远端 CI。

## 已执行证据

环境：本机 macOS，Node v26.4.0；仓库要求 Node >=24。测试采用临时目录、假 GitLab/Codex/飞书 CLI 与真实临时 Hub/Worker，不读真消息、不写真实 MR。

| 阶段／矩阵 | 实际执行与结果 |
|---|---|
| 原版基线 | CI、poll、config、scan、manual、飞书测试共 34 项通过；独立集成基线 1 项通过，退出码均 0 |
| 故障复现 | 新增回归在旧代码上 24 项中 8 项出现断言失败；集成在“当前 MR 未满足审查条件”失败。均为行为失败，不是语法错误 |
| CI-01 GitLab 扫描触发 | 定向 ci/poll/scan 测试通过；覆盖所有旧模式、不同状态、空／缺失 pipeline 与旧 SHA，禁止访问 CI 端点 |
| CI-02 飞书委托触发 | 假 CLI 的明确请求、卡片确认、草稿拒绝、未指定 Reviewer、旧流水线及丢失回执重放通过 |
| CI-03 审查与发布连续完成 | 真实临时 Hub/Worker 集成通过；CI 失败时开始审查，执行中改为失败流水线仍保存报告，卡片确认后子流水线失败仍发布；severity 模式在失败 CI 下通过 |
| CI-04 去重与版本保护 | scan、飞书重放、integration、publish 既有回归通过，已投递同 head 与历史报告复用保持不变 |
| CI-05 升级兼容及授权边界 | 所有旧 CI 配置继续校验，CI 参数不影响新 policyHash；manual、answer、manifest 与发布回归通过，状态／草稿／身份／版本／授权校验保留 |
| 定向回归 | `node --test tests/gitlab-ci.test.ts tests/gitlab-poll.test.ts tests/gitlab-config.test.ts tests/gitlab-scan.test.ts tests/gitlab-integration.test.ts tests/gitlab-manual.test.ts tests/feishu-review*.test.ts`：33/33，退出码 0 |
| 必要回归 | `npm run test:quick`：392/392，退出码 0；`npm run typecheck`、`npm run format:check`：退出码 0 |
| 独立审查 | 新子 agent 按 code-review 审查 M1 起始提交至当前增量，findings=[]；独立执行相关测试共 47 项通过；未改文件 |

以上代码测试对应实施后的工作区版本，提交后由远端 CI 再核实实际提交。未运行模拟、穷举或 nightly，因为未修改内核、日志、到期表与并发机制。未执行真实 GitLab 评论发布、生产升级或本人试用，不将隔离测试描述为目标环境验收。

## 兼容与提交范围

- 保留内部准入入口及旧参数签名，删除 pipeline 条件及查询；所有扫描、执行、续办和逐条发布调用直接获得一致行为。
- 旧 CI 字段与覆盖值保留读取校验，历史请求、报告与批准不改写；仅新的 policyHash 不再纳入 CI 配置。
- 飞书第二入口的既有未提交代码、测试、示例及 poll 接入是本次双入口闭环的必要依赖，一并审查后纳入本任务提交。
- 远程 Worker 工作树清理实现和对应测试、文档措辞，以及看板方案／计划均不纳入提交。共用文档采用精确暂存保留这些未提交差异。
- 当前 main 已包含远程 Worker 的 PR #1；本分支另有三个已提交的原生 MR 链接审查、有效 findings 保留和仅 head 重审提交，本轮不重写这些历史，最终 PR 累计审查单独覆盖。
