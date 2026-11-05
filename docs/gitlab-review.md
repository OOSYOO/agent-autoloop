# GitLab 审查配置

GitLab 扩展运行在接单程序所在的 Mac。它使用现有的来源、规则、接单程序和卡片，不修改中台协议。先只启用人工确认；不要把私有配置、密钥、报告或裸仓库提交进项目。

1. 安装 Node 24 或更新版本、Codex CLI 和 glab，登录目标 GitLab。用 `glab api user --hostname <主机>` 核实账号 ID；确认 Codex 和飞书通道已经登录。飞书 CLI 本次实测版本为 1.0.98；旧版 1.0.80 不支持通道使用的 stdin 内容和卡片更新命令，需先运行 `lark-cli update`，无需为旧版修改插件。同一飞书应用已有卡片监听时不要再启动一个监听。
2. 准备私有目录，权限设为 `0700`。创建 `gitlab` 来源并用 `agent-autoloop key new source gitlab` 生成该来源密钥，将输出保存为私有文件并设为 `0600`。不要把密钥放进规则或仓库。中台 `sources` 必须有 `gitlab`，对应项目的事件类型只能匹配一条 review 规则。
3. 为项目准备独立裸 Git 缓存，不能使用正在开发的工作树。缓存须包含目标 MR 的 Head 和 Diff 的 base/start 对象；缺少对象时会从缓存中配置的可信 `origin` 拉取分支和该 MR 的 head。快照从裸对象导出完整文字资料和 Diff，`index.json` 映射原始路径；二进制以十六进制保存，无法完整导出时阻塞。文件改名为数据文件，不检出或运行 MR 代码，也不把 MR 的 AGENTS 或 Skill 当作指令。审查 Skill 文件须由本人信任。
4. 在私有目录新建下面的 JSON，替换所有占位值。`instanceUrl` 默认要求 HTTPS；只有本人明确认可的内网 HTTP 才设置与之完全相同的 `trustedHttpOrigin`，不会自动降级。`hubUrl` 指向本机中台，`sourceKeyPath` 指向第 2 步的密钥文件；`dataRoot` 是私有数据目录。模型和 effort 在配置顶层，一份配置内各项目共用；需要不同模型时使用不同配置文件及各自的 command/规则。

```json
{
  "schema": 1,
  "instanceKey": "work",
  "instanceUrl": "https://gitlab.example.com",
  "reviewerId": 123,
  "hubUrl": "http://127.0.0.1:3000",
  "sourceKeyPath": "source.key",
  "dataRoot": "data",
  "model": "gpt-6.1-terra",
  "codexPath": "codex",
  "glabPath": "glab",
  "projects": [{
    "id": 42,
    "projectPath": "team/project",
    "rulesBranch": "main",
    "publication": "severity",
    "ciMode": "required",
    "cachePath": "cache/project.git"
  }]
}
```

`projectPath` 必须与 GitLab 项目路径一致，裸缓存 origin 必须对应同一项目；`rulesBranch` 仅接受 `main`，省略时也使用 `main`。每个裸缓存旁派生一份专用 `<缓存名>.codereview-worktree`：每轮从远端更新到最新可信分支 commit，Codex 在这里原生读取仓库规则与 Skill。目录归属不匹配或有未提交改动时停止，不覆盖别人的目录。日常开发目录不会被 pull、reset 或切换分支。MR 的 Head、描述和差异仅作为独立文字资料，不被当成规则；不执行 MR 代码、测试或 hooks。共享审查目录按任务更新，不提供多版本隔离。

`publication` 可选 `manual`、`auto` 或 `severity`，缺省为 `manual`；`ciMode` 缺省为 `required`，只接受当前 Head 的成功 pipeline；仅在本人确认项目没有 CI 时设置 `confirmed-none`，此时接受没有 pipeline，或当前 Head 的成功 pipeline。项目 CI 尚未上线且本人明确允许跳过时，可为该项目设置 `allow-skipped`：仅接受当前 Head 的 `success` 或 `skipped`，无 pipeline、旧版本以及失败、等待或取消均不放行。可选 `effort` 与上游 Agent 的 effort 一致；省略时使用 Codex 默认。运行参数中的模型和 effort 必须与配置一致。

5. 使用标准 `gitlab` 插件，不再引用开发目录里的脚本。以下片段合入现有 `rules.json`，保留其他任务。`mac-worker` 换成本机接单程序名称，项目 ID 与配置一致。工作目录放在固定的数据目录；模型和 effort 只在 GitLab 配置维护一份。

```json
{
  "sources": { "gitlab": { "name": "GitLab" } },
  "agents": {
    "gitlab-scan": {
      "name": "GitLab 扫描", "worker": "mac-worker", "use": "gitlab", "timeout": 120,
      "command": ["scan", "--config", "gitlab/config.json"]
    },
    "gitlab-review": {
      "name": "GitLab 审查", "worker": "mac-worker", "use": "gitlab", "timeout": 1800,
      "command": ["review", "--config", "gitlab/config.json"]
    }
  },
  "rules": [
    { "name": "gitlab-scan", "when": { "cron": "*/5 * * * *" }, "to": "gitlab-scan", "prompt": "按可信配置扫描 GitLab。", "cwd": "/PRIVATE/gitlab/work", "group": "gitlab-scan", "parallel": 1 },
    { "name": "gitlab-review-42", "when": { "source": "gitlab", "types": ["mr.review.42"] }, "to": "gitlab-review", "prompt": "按照项目规则、使用ponytail, neat-freak和code-review详细审查这个MR", "cwd": "/PRIVATE/gitlab/work", "group": "gitlab-review", "parallel": 1 }
  ]
}
```

GitLab 审查任务指令来自唯一匹配的 `rules.prompt`，每轮核对 Hub 的规则快照。Codex 在专用工作树原生发现适用规则和 Skill；不维护独立 Skill 名单或逐文件规则白名单。扫描与发布前用 Codex 的原生 catalog、有效配置摘要、Skill 文件内容与 main commit 计算策略摘要；任一依据变化使旧报告和批准失效，历史记录保留。扫描和检查不调用模型。不可缺少的 Skill 或能力不可用时报告执行失败，不能冒充零 findings。

旧 GitLab 配置中的 `skill`、`skillPath` 和 `projects[].rules` 以及 GitLab 路由的 `rule.skill` 均不兼容，需移除；其他 Agent 的通用 `rule.skill` 不变。Codex 使用本机原生配置和 Skill 发现。只读审查、不执行 MR 代码、测试或 hooks、不发布是本轮任务要求；不声称插件额外隔离了 MCP、网络或用户配置，也不声称 Skill 的每一步均已执行。

配置路径相对 `AGENT_AUTOLOOP_HOME`；密钥、数据和裸缓存路径相对配置文件。`codexPath`/`glabPath` 可写程序名；扫描仍使用通用 cron。

6. 在启用定时扫描前运行 `agent-autoloop gitlab check` 和 `agent-autoloop check`，核对每个项目类型仅一条规则匹配、来源密钥身份及飞书本人收件人。可在终端使用 `agent-autoloop gitlab scan --mr <MR链接>` 手动请求；若本人要覆盖 reviewer、draft 或 ci 门槛，追加 `--override reviewer,draft,ci --reason <原因>`，仅填写需要覆盖的项。覆盖不改变版本和发布策略。修复未路由的规则后，使用 `--retry-unrouted` 启动扫描，让新观察重新投递。
7. 用 `agent-autoloop status` 查看事项。manual/auto 模式的飞书展示全部 findings，并标明哪些会发布为行内评论；多页时按 MR、版本和报告摘要核对全部页面。人工发布卡仅批准其中标记为“将发布”的评论；也可用 `agent-autoloop answer <卡片ID> 1` 发布或 `2` 拒绝。需求、文档或验收标准的矛盾作为 finding，不会暂停审查向作者提问。无法读取或模型运行失败时，本轮失败而非报告零 findings。内容超过飞书可承载容量时本轮失败，不产生不完整的批准卡。自动模式仅发布有有效 Diff 位置的 P0–P2；发现本工具在其他版本已发过评论时，整份报告转人工比较。停止当前轮不能撤回已发评论；要停止后续扫描，应关闭对应规则。

每次模型调用的 prompt、schema、原始输出、事件流与模型状态保存在私有审计目录，报告以相对路径关联；不保存环境变量。报告、确认和外部动作记录保存在 `<dataRoot>/gitlab/`。如果发送结果不明，系统先核查，不会仅因为暂时查不到评论就重发；请本人核查 GitLab。真实测试 MR 和飞书收件人须明确授权后再做写入验收。


## 安装与维护

本地尚未发布的实现可在源码目录执行 `AGENT_AUTOLOOP_HOME=<固定数据目录> node bin/agent-autoloop.ts install-local`。先停止该实例；安装不会替你中断审查。安装产物在 `<固定数据目录>/app`，启动入口为 `<固定数据目录>/bin/agent-autoloop`，入口固定对应实例，不依赖当前目录。配置、密钥、缓存和历史不放在 app 内，重装保留它们。已有未受管理的 app 或入口文件会拒绝覆盖。

使用安装入口运行 `gitlab check`、`check`、`status` 和 `service install`。系统服务在登录后启动，异常退出由系统重启；它和命令行引用同一份安装产物。开发目录改名不影响运行。更新本地包时停止实例，从新版源码重新执行 install-local，再从固定入口启动服务；本地包的 update 不会误用 git pull。`uninstall --yes` 删除程序与系统服务，保留数据。来源提交和安装时间保存在 app/local-install.json；本地未提交修改属于本地构建，不表示已有发布版本。

`gitlab check` 仅核对本地配置、程序、密钥权限、路由和裸缓存，显示派生的审查工作树路径；不联网、不验证原生 Skill 或运行安全配置、不审查、不发消息；GitLab 登录状态可另用 glab 检查。数据目录自身改名仍需重新安装入口和系统服务；备份时应一起备份配置、密钥和业务记录，不能只移动 app。


GitLab 项目可设置 `publication: "severity"`：P0/P1 自动发布且不发送正常结果通知，P2 通过飞书确认后发布；混合报告分开处理，P3 仅告知。零 findings 仍发送带 MR 链接的通知，提示继续人工 review / 审核。该模式下无法行内定位的问题发布为普通 Discussion，保留文件与行号；执行异常单独处理。旧 `manual` / `auto` 模式保留。

重审依据限定为 MR 版本、main、可信 prompt、模型，以及 prompt 明确提到的原生 Skill 正文及其目录引用资料、全局仓库指令和指令相关 Codex 设置。无关 Skill、插件安装清单、项目信任列表及界面设置变化不触发重审。这里的名称匹配只筛选失效依据，不负责加载 Skill；实际发现和读取仍由原生 Codex 完成。扫描、缓存、回答续办和发布前核验使用同一依据，旧摘要下的批准不复用。
