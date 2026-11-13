# 安装说明（写给 Agent）

用户请你装好 Agent 自动化中台。先安装，再走一遍提问和继续处理；能自己做的直接做。

## 安装

支持 macOS、Linux，暂不支持 Windows。需要 Node.js 24 或更新、Git、curl，以及一个已经登录的命令行 Agent。

先检查 `node --version`。Homebrew 的 `node@24` 默认不进 PATH，装好后还要运行 `export PATH="$(brew --prefix node@24)/bin:$PATH"`；需要长期生效时再写入用户的 shell 配置。不要替用户登录，也不要读取或复制登录凭据。

本仓库已公开，安装脚本和代码都可匿名下载，不需要 GitHub 账号、登录或 GitHub CLI（`gh`）。下面的命令安装并启用登录后常驻服务：

```bash
curl -fsSL https://raw.githubusercontent.com/KKKKhazix/agent-autoloop/main/install.sh | sh
```

GitHub Issue 轮询和 PR 交付等功能另需已登录的 `gh`，按对应场景说明配置；运行 Agent 也仍需该 Agent 自己的登录或授权。

用户指定本地仓库时，用该目录的安装脚本，并把 `AGENT_AUTOLOOP_REPO` 设成它的绝对路径。不要下载 GitHub 的旧脚本，也不要用未提交的文件冒充已安装版本；安装器克隆的是本地仓库的 HEAD。

下面以 `/path/to/agent-autoloop` 为例，使用已经登录的 Codex：

```bash
AGENT_AUTOLOOP_REPO=/path/to/agent-autoloop sh /path/to/agent-autoloop/install.sh --agent codex
```

`--agent claude` 选择 Claude Code；只有其他 CLI 时加 `--command 'hermes chat -q {prompt}'`。不指定时会检测本机安装的 Agent，第一种作为试跑对象。

程序装进 `~/.agent-autoloop/app`，配置和记录留在 `~/.agent-autoloop`。默认打开桌面通知；没有图形会话时安静跳过，问题仍能用 `agent-autoloop status` 查看。命令优先放在 PATH 中的 `~/.local/bin`，否则选 PATH 里第一个可写目录，不用 sudo、不覆盖其他程序；没有位置时使用安装器打印的完整路径。

安装器和中台启动时都会把数据目录设为 `0700`，包括已有目录，阻止其他系统用户读取数据库、事件和运行输出。升级后同步重启中台与接单程序；新版 `status` 使用中台提供的费用汇总。

升级时若投影格式有变化，会自动从旧日志逐条重建，历史多时首次启动需要等待；之后正常启动直接复用投影。原日志和已有卡片链接保留，不需要手动迁移。

## 临时 HOME、CI 或没有服务管理器

使用临时 HOME 时不要装系统服务，不改真实用户的 shell 配置和 Agent 配置。保留调用者给定的 `AGENT_AUTOLOOP_HOME`；用真实 `CODEX_HOME` 只为了沿用已经完成的 Codex 登录。

在临时环境中选一个空闲端口，运行本地安装脚本，随后启动中台：

```bash
port=$(node -e 'const s=require("node:net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
AGENT_AUTOLOOP_REPO=/path/to/agent-autoloop sh /path/to/agent-autoloop/install.sh --agent codex --no-service --port "$port"
agent-autoloop up
```

`up` 会一直运行。在 Agent 的命令工具里保留它返回的运行中会话，再用另一条命令完成验证；不要用 `nohup … &` 代替，命令工具可能在退出时清理后台进程。看到监听地址后再运行验证命令；启动失败就先处理该会话里的错误。

PATH 没有命令时，把 `agent-autoloop` 换成安装器打印的完整路径。临时测试使用假的 `osascript`、`notify-send`，不要发送真实消息；不要给已在线的飞书应用再开监听。

## 验证

先查看安装和连接情况，再用真实 Agent 跑完整问答：

```bash
agent-autoloop --version
agent-autoloop doctor
agent-autoloop try
```

`try` 会使用用户的模型额度。在非交互终端，它打印问题和 `agent-autoloop answer` 命令后退出；这是正常等待，不是失败。把问题转给用户，按他的选择回答，再运行 `agent-autoloop status`，看到“试跑通过”才算接通。仅为安装验证时，可以选择第二项绿色完成试跑。

Claude 要委托 Codex 处理网页时，可用[浏览器交接模板](examples/recipes/browser-handoff/README.md)，先配置现成入口，再验收首次调用与原会话续办。模板不安装浏览器驱动、不自动放宽 Claude 命令权限。

任务还需要网页操作时，另按[浏览器接入](docs/plugins.md#浏览器接入)用同一后台启动方式核实实际页面和会话接续。`try` 只证明问答流程；中台不自动提供浏览器连接或修改 Agent 的工具配置。需要本人恢复连接、登录或验证时，保留待验收项并交 `ask`，不要反复重跑已完成的业务。

没有安装系统服务时，`doctor` 会显示服务未运行；检查中台、Agent 和桌面通道是否在线即可，不要为了消除这条提示安装真实服务。

## 写第一条规则

安装验证完成后，按用户希望自动处理的事从 [README 的场景模板](README.md#拿来即用的场景模板)选一个，再照[配置手册](skills/agent-autoloop/SKILL.md)写规则；用户还没指定用途时再问。用 `agent-autoloop check` 检查；改动几秒内生效。

国内业务可从反馈处理、网站巡检、飞书周报与业务摘要三套模板开始。它们默认飞书本人私聊；替换占位符后，配置和业务资料留在私有目录，不提交到仓库。模板不替用户新建凭据或扩大飞书权限。

桌面通知只在这台电脑上显示。需要别的通道时，先确认接收位置，再按配置手册接入。不要直接测试发信或发群消息。`access` 的含义见[插件说明](docs/plugins.md#access-实际能做什么)，不要替用户扩大权限。

## 卸载

卸载程序，默认保留规则、密钥和记录：

```bash
agent-autoloop uninstall
```

终端里确认后才执行；非交互运行时加 `--yes` 跳过确认，数据同样保留。它只停自己的服务和进程、删除指向自身的命令及 Skill 链接，以及安装目录里的 `app`。其他同名文件不动；数据目录不删除。

临时安装验证完，用 `agent-autoloop uninstall --yes` 停掉本次进程，再清掉自己创建的临时目录。不要卸载用户已经在用的中台。

## 文档

- [配置手册](skills/agent-autoloop/SKILL.md)：接事件插件、通道、多台电脑和交付流水线。
- [协议](docs/protocol.md)：HTTP、回执、事实日志和故障恢复。
- [插件](docs/plugins.md)：三个可运行的最小例子。
- [安全边界](SECURITY.md)：密钥、执行权限和交付审查。

开发检查用 `npm test`、`npm run typecheck`、`npm run format:check`，完整故障与性能检查用 `npm run test:nightly`。备份同时保留 `hub.db` 和 `master.key`；后者权限应为 0600。

GitLab MR 审查另见 [GitLab 审查配置](docs/gitlab-review.md)，先使用人工确认并核对私有目录与来源身份。

GitLab 部署支持固定目录的本地安装包（`install-local`），用 `gitlab check` 检查本地配置、`gitlab scan` 立即扫描。配置内数据路径相对配置文件，模型只在私有配置中维护；定时扫描仍用通用 `when.cron`。安装、更新和保留数据的卸载见 [GitLab 配置指南](docs/gitlab-review.md)。

GitLab 审查直接使用 `rules.json` 的 `prompt`。每个仓库复用一个专用 `codereview-worktree`：首次从 `origin/main` 创建，后续任务更新到最新 main 时强制丢弃该专用目录的未提交改动和未跟踪文件，再在该目录启动 Codex。仓库规范、仓库级及个人 Skill 由 Codex 原生发现和读取，插件不维护逐文件规则清单或另一套 Skill 加载器。MR 以链接交给 Codex 自行读取，要求不检出或执行 MR 代码，也不改动日常开发目录。旧 GitLab `skill`、`skillPath`、`projects.rules` 和 GitLab 路由的 `rule.skill` 均明确拒绝；其他 Agent 的 `rule.skill` 不变。详见 [GitLab 配置指南](docs/gitlab-review.md)。


更新此开发版前确认实例空闲并停止自身服务，备份配置后移除上述旧字段；不需要数据迁移。保留数据库、密钥、历史和已有兼容符号链接，更新程序后只启动一份服务及飞书监听。`gitlab check` 通过只代表本地配置有效；原生 Skill 目录在扫描时读取，实际使用情况由审查过程记录。专用工作树由裸缓存路径派生为同目录的 `<缓存名>.codereview-worktree`，不使用日常开发目录。


GitLab 项目可设置 `publication: "severity"`：P0/P1 自动发布且不发送正常结果通知，P2 通过飞书确认后发布；混合报告分开处理，P3 仅告知。零 findings 仍发送带 MR 链接的通知，提示继续人工 review / 审核。所有模式均以普通 Discussion 发布，保留文件与行号；执行异常单独处理。旧 `manual` / `auto` 模式保留。

GitLab 审查卡片只展示 MR 链接、问题与影响摘要、建议和待发布条数；摘要按原文截短，最多预览五条，不再展示提交、策略和报告哈希。飞书可展开完整报告查看位置、证据及逐项发布范围；超长报告分成带 MR 链接的通知，确认卡说明页数。完整评论及版本、权限、清单核验保持不变，旧卡片仍可回答。

自动重审只由 MR 提交版本（head SHA）变化触发。已投递的同一 head 不因 main、prompt、Skill、模型、发布配置、Reviewer 或 CI 状态变化再次派发。首次尚未满足准入的 MR，在合格后首次启动。真正审查任务开始时才更新 main 工作目录并加载可信 Job 指令；扫描不更新工作树或枚举 Skill。同一 head 复用最新已完成报告及其内容摘要，不改写时间和请求编号来制造新报告。main、prompt、Skill 和模型保留为审计依据，不用于使同一 head 的报告或批准失效。发布仍核对 MR head、当前项目身份、Reviewer 和明确授权；切换分级发布只重新分流已有 findings，不重新调用模型，旧的整份人工清单不会自动获得 P2 发布权限。


GitLab 扫描与审查可一起交给远程 Linux Worker，中台与通道留在 Mac；两端使用独立数据目录与同一规则副本，服务器 capacity=1。部署、断线恢复和切换约束见[远程 Worker](docs/gitlab-review.md#远程-worker)。

GitLab 审查从扫描到评论发布均不等待 CI；旧 CI 配置仅兼容读取，详见[CI 配置兼容](docs/gitlab-review.md#按自动检查判断审查时机)。

GitLab 审查只准备可信 main 工作目录，然后启动原生 Codex，发送 rules.prompt 与 MR 链接（附当前提交供核对）。插件不预下载、转换或校验 MR Diff，不准备 MR Git 对象或上下文副本；MR 的读取由 Codex 按 Skill 自行完成。发布统一使用普通 Discussion，正文保留文件和行号；发布前仍核对版本、策略和授权。同一 head 的 findings 可复用；发布清单的授权范围仍逐项核对。

飞书可作为 GitLab 审查的第二入口：用本人身份轮询群聊 @ 和私聊，明确请求自动审查、模糊请求用卡片确认。只覆盖 Reviewer，保留草稿和发布策略，CI 不再作为门槛；同 head 不重复派发，不回复同事。使用标准 `feishu` Agent 插件，显式配置后启用；权限、串行接入与部署见[飞书消息委托审查](docs/gitlab-review.md#飞书消息委托审查)。

## 本地任务看板

安装包已经包含看板，无需另装项目。运行 `agent-autoloop dashboard` 后打开打印的地址，默认 `http://127.0.0.1:3352`；用 `PORT=3353 agent-autoloop dashboard` 改端口。配置沿用 `AGENT_AUTOLOOP_HOME/config.json` 中的回环中台地址和本人密钥；中台离线时页面提示连接失败。看板不启动中台，不自动打开浏览器，Ctrl-C 只关闭看板，任务和通道继续运行。

升级顺序：先 Ctrl-C 退出看板，再按当前安装方式运行安装或更新命令，最后重启 `agent-autoloop dashboard` 并重新加载浏览器页面。更新命令不会自动重启看板；旧页面遇到进程变化会禁用提交并提示重载。旧独立看板目录不再是运行依赖，不要同时运行两份占用同一端口。
