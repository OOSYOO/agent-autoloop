# 本地看板 M5 整体验收

- 方案：../specs/local_dashboard.md；计划：../plans/local_dashboard.md 新方案执行。
- 起点及被测实现：`52063bd`，分支 `main`。无新工程范围；M4 已完成完整实现，M5 核实安装和整体交付，组织本人 L4。
- 状态：本人于 2026-11-13 明确回复“这样可以了，验收通过，继续完成交付收尾”；最终实现 `9cf22c8` 的 L4 通过，临时环境已清理。最终累计审查 3/3，findings 为空，CI 修复 0/3。M5 本地里程碑完成；汇总 PR 为 [#6](https://github.com/OOSYOO/agent-autoloop/pull/6)，最终 CI 与可审阅状态以 PR 检查页为准。

## 自动验证与范围证据

M4 的 417 项全量测试含 200000 步模拟、40320 条穷举路径；之后焦点修复经最终看板/安装 21 项定向复跑，类型和格式检查通过。所有有效证据都覆盖 `52063bd` 的最终代码，详见 M4 记录。

`sh scripts/install-smoke.sh` 基于已提交 `52063bd`，临时 HOME，从 install.sh 安装到启动中台、访问看板静态模块/状态、退出看板确认中台继续响应、试跑问答和卸载，退出 0。假桌面命令只记录测试结果，不弹通知；无在线飞书监听和真实数据。原始日志 `/tmp/local-dashboard-install-smoke.log`。

浏览器已观察：首页只有汇总、待我处理和定时任务；报告按纯文本渲染；推荐未预选，未选择时不可提交；选择后确认文案准确，焦点仍在选项。截图：`/Users/shenyue/.codex/visualizations/2026/11/13/01a1d2dd-095e-7582-9379-3a00161df05b/local-dashboard-preview.png`。这些是 agent 的界面核对，不代替本人主观可读性结论。

## 本人 L4 清单（已完成，操作与事实见最终收尾）

临时真实中台仅保存验收数据，没有启动真实 Worker、通道或评论发布；“发布 3 条评论”只记测试决定。

1. 打开临时看板，查看汇总/待处理/定时任务，没有完成列表；没有默认选项。
2. 打开报告、展开完整内容，判断是否容易读懂；选任一选项，明确确认后应显示“决定已提交”，待处理从 2 变 1（不显示评论已发布）。
3. 打开通知，点“已处理”，待处理变 0，首页显示“暂时没有需要你处理的事项”。
4. 回复通过或具体异常，尤其说明报告阅读与处理文案是否清楚。随后 agent 收集临时中台事实与截图，判定该行并停止清理验收进程。

历史准出要求：收到本人结论后收集事实、判定 L4、停止并清理临时环境；目前均已落实。

## 授权与远端边界（收尾时修正）

用户要求当前分支执行，因此本地一直保留 main，未另建 worktree 或副本。此前将此解释为禁止专用远端交付分支过于保守；用户确认验收并要求完成收尾后，保持本地 main 不切换，使用本次专用远端 `codex/local-dashboard` 创建 PR 到 origin/main，不推送 main、不合并。旧目录非运行依赖，既有修改保留。

## 已清理的临时环境与历史通知

- 被测代码 `52063bd`；临时页面 `http://127.0.0.1:50125/`，临时中台 `http://127.0.0.1:56806/`。最终代码启动后浏览器已重载，初始待处理 2。
- 已停止清理的验收进程：PID `84167`，入口 `/tmp/local-dashboard-preview.ts`（工具会话 37329）；临时 HOME `/var/folders/fs/00kc56d1769dl22sthd1vxqh0000gn/T/local-dashboard-acceptance-S3ekJX`。不修改真实 HOME；SIGTERM 会清理临时数据。
- 最终累计审查：新子 agent 审查 `a7b6acb..52063bd`，findings 为空，定向测试 21 项通过。
- 按 deliver 通知规则，通过 lark-im 以 bot 身份给本人发出 L4 就绪私信，CLI 返回 ok=true，消息 `om_x100b605c62438cbcceebfde78e347b7`。当前会话无专用桌面通知工具，桌面通知未发送；会话和飞书通知可用于本次请求。
- MVP 工程能力已就绪，主观可读性及本人试用价值未验证；M5 未结束，不自动扩展任务。

## 本人反馈修订：待处理摘要需要明确对象

用户未确认 L4 通过，而是要求列表直接显示仓库、MR 编号和 MR 标题。已在 `13256e8` 修订：GitLab 从已读取的 MR 资料补充报告及确认正文首段；分页容量包含该说明。看板展示任意卡片的纯文本首段预览（最多 300 字加省略号），详情保留全文。不主动请求 GitLab，不重写既有卡片或猜测缺失标题，审批授权语义不变。

- 新增 presentation/view-model 测试先因缺少身份资料和 preview 失败，实现后通过；真实 GitLab 插件 receipt 和实际列表渲染也有回归覆盖。
- `npm run test:quick`：417 项通过，日志 `/tmp/local-dashboard-mr-quick.log`；`npm run typecheck`、`npm run format:check`、`git diff --check` 通过。未修改 kernel/protocol/sim，未重复此前模拟穷举。被测代码对应 `13256e8`，测试时为未提交工作树，提交前未再改代码。
- 最终累计第 2/3 轮独立审查 `1e2f930..本次修订`，findings 为空。
- 浏览器重载后首页直接显示 demo/workflow、!42 和“修复登录后任务列表不刷新的问题”。截图：`/Users/shenyue/.codex/visualizations/2026/11/13/01a1d2dd-095e-7582-9379-3a00161df05b/mr-card-preview.png`。这些是临时验收示例，不是真实 MR。
- 最新临时环境见上一节更新后的 PID/HOME/URL；M5 仍等待本人阅读与操作体验确认，未宣称完成。

## 本人反馈修订：MR 信息合并成命名链接

用户要求参考 GitLab 首页，将分行仓库/MR/标题/裸 URL 收为单条链接。现在完整且带安全 HTTP/HTTPS 链接的 MR 首段在列表显示为“demo/workflow !42：修复登录后任务列表不刷新的问题”；缺失或不安全链接仍保留普通文本，正文与服务协议未修改。不将正文当作 Markdown/HTML 执行；链接仅新窗口打开，带 noopener noreferrer，刷新保留链接焦点。

- 两项行为测试先以 reference=undefined/找不到链接复现失败，实现后通过。
- `npm run test:quick` 419/419 通过，`npm run typecheck`、`npm run format:check`、`git diff --check` 通过。日志 `/tmp/local-dashboard-link-quick.log`。这节对应包含本节的提交；测试时为未提交工作树，后续只补文档和提交说明。
- 最终累计范围第 3/3 轮独立审查，基线 `9718303`，findings 为空；未重置此前轮次。
- 浏览器重载核实：仅一个命名 MR 链接，无重复四行字段或裸 URL。截图 `/Users/shenyue/.codex/visualizations/2026/11/13/01a1d2dd-095e-7582-9379-3a00161df05b/mr-compact-link.png`。最新临时环境见上节更新后的 PID/HOME/URL，M5 仍待本人整体阅读与操作体验确认。

## 最终收尾：验收通过

- 用户原话：“这样可以了，验收通过，继续完成交付收尾。”采纳本人对主观可读性与操作展示的结论，最终实现 `9cf22c8`。之前反馈与待验收叙述是历史过程，不再是当前待办。
- 补充最终浏览器操作：未预选，选择“不发布”并明确提交，看到“决定已提交”；处理验收通知看到“通知已处理”。两张原验收卡从待处理列表移除。长时间没有真实 Worker，临时定时任务继续生成离线通知；新增通知不同于已处理卡，没有被误判为原卡恢复。
- 事实证据：answer seq=38，card=1/state=decided/choice=1/answer=null/by=本人；seq=39，card=2/state=closed；seq=40，card=3/state=closed（临时离线通知）。补充操作由 agent 执行，仅作用于临时 HOME；未发送真实评论或通道消息。证据 `/tmp/local-dashboard-closeout-evidence.json`，截图 `/Users/shenyue/.codex/visualizations/2026/11/13/01a1d2dd-095e-7582-9379-3a00161df05b/local-dashboard-passed.png`。空列表由既有自动化验证覆盖，不宣称截图中新增离线通知不存在。
- 最终 `9cf22c8` 的 `sh scripts/install-smoke.sh` 再跑一次，退出 0；日志 `/tmp/local-dashboard-final-install.log`。此前全量内核模拟/穷举和最终 419 项快速回归、类型/格式检查依然有效，本次只变更记录。
- 验收浏览器标签页已关闭，PID 84167 已 SIGTERM 退出，临时 HOME 已确认删除；入口脚本已删除。其余测试证据日志保留。发现另有旧独立看板 server.js（PID 89733），非本次启动，未停止；旧目录 M3 交付记录改动也未动。新维护入口仍为本仓库 dashboard/。
- 汇总 PR 已创建：[OOSYOO/agent-autoloop#6](https://github.com/OOSYOO/agent-autoloop/pull/6)，远端分支 codex/local-dashboard，目标 main；本地仍为 main。后续在 PR 描述记录最终 CI 链接并在检查通过后解除 Draft，不自动合并或部署。

## 交接结果

M4/M5 的工程与本人验收均完成，最终业务代码为 `9cf22c8`，收尾记录为 `96aaed3` 及包含本节的文档提交。最后两笔只改变文档，既有测试和独立审查证据继续有效。最终远端检查在 [PR #6 检查页](https://github.com/OOSYOO/agent-autoloop/pull/6/checks) 持续对应当前 PR head，CI 链接与结果同步 PR 描述；CI 失败则不解除 Draft。合并、发布、部署与正式环境试用不在本次交付中。
