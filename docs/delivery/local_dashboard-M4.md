# 本地看板 M4 交付记录

方案：docs/specs/local_dashboard.md；计划：docs/plans/local_dashboard.md 新方案执行。
范围：同仓库完整页面、启动与安装、状态验证、受限审批代理、生命周期；不修改内核业务协议。
基线：a7b6acbd46a6fbc942a8f55b18d49f9d90f9bf8b。
当前分支 main，用户要求沿用；不推送 main。旧看板 3e4671f 为参考，旧目录交付记录改动保留。
状态：M4 实现与验收完成，准备精确提交；审查 3/3，最终 findings 为空，CI 修复 0/3。

验证环境：macOS，Node 26.4.0；全部中台数据使用临时 HOME，HTTP 使用随机端口；不调用在线飞书和真实发布。首次测试因模块/入口不存在而失败，后续审批代理及 UI 用行为测试覆盖。新增报告折叠/键盘焦点复现测试在修复前以 true !== false 失败，修复后通过。

- `node --test tests/dashboard-*.test.ts`：16 项通过（后续新增焦点回归单独 8/8 通过，最终重跑覆盖）。
- `node --test tests/dashboard-install.test.ts tests/local-install.test.ts`：5 项通过。
- `npm run typecheck`、`npm run format:check`：退出 0。
- `npm test`：退出 0，417 项全部通过，固定种子 24301 的 200000 步模拟、有界穷举 40320 条路径/654920 次转换；原始日志 `/tmp/local-dashboard-tests.log`。完整运行后只修改页面焦点保持及对应测试，未触及内核/模拟；最终定向复跑 `node --test tests/dashboard-*.test.ts tests/local-install.test.ts` 21/21 通过（看板 18 + 安装 3），类型/格式退出 0，覆盖后续改动。
- 独立审查：第 1/3 轮发现 1 个 P2（选项重绘丢失焦点与折叠），已补失败测试并修复；第 2/3 轮发现同根因扩展：确认/关闭/展开/链接焦点未覆盖，补失败测试后一起修复；第 3/3 轮 findings 为空。
- 不改变协议：新本地接口只选原选项，`/v1/*`、日志/投影和内核并发算法未变，不额外跑 nightly。
- 安装冒烟只读已提交代码，安排提交后执行，证据归 M5。浏览器主观阅读验收也归 M5。

新版矩阵映射：

| 验收行 | 实际入口与结果 |
|---|---|
| 安装/启动/退出、非法配置、版本一致性 | dashboard-install.test.ts、local-install.test.ts：通过；安装后不依赖原目录，静态资源固定、旧标识写入被拒、退出上游断开且仍响应 |
| 精简汇总、时区、定时及外部状态 | dashboard-view-model.test.ts：通过；直接沿用中台 doneToday，unknown 不显示等待，重派为 queued 子集 |
| 详情/原选项/旧问题/轮询/失败保留/迟到读取 | dashboard-app.test.ts：9 项通过；推荐不预选，无文字，结果不确定只读核实，成功后缓存不重开；焦点与报告折叠回归通过 |
| 真实审批、通知和竞争 | dashboard-hub-integration.test.ts：通过；真实中台事务/日志，仅一条有效回答，Worker choice=0/text=null，后到 changed=false，通知不续办 |
| 超时正文、畸形响应、同源/密钥隔离、恶意链接和正文 | dashboard-server.test.ts 5 项及 app 恶意内容测试：通过；预读 UPSTREAM_TIMEOUT 无写入，写入后 OUTCOME_UNKNOWN、不重发，无 owner 错误回显 |
| 原 GitLab 发布兼容、内核边界 | 完整 npm test 的 gitlab-answer/integration、http、cards、purity 及其他既有回归均通过 |
| 已提交安装冒烟、浏览器和人工主观可读性 | M5 接续；不以本阶段通过代替本人 L4 |

旧目录仅其 docs/delivery/local_dashboard-M3.md 有用户既有未提交改动，未覆盖、未删除，运行与维护来源为本仓库。
