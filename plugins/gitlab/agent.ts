import { resolve, join } from "node:path";
import { HOME } from "../../host/home.ts";
import type { Adapter } from "../../worker/agents.ts";
import command from "../command/agent.ts";
import { loadConfig } from "./config.ts";

export default {
  command(turn) {
    const argv = turn.command ?? [];
    if (argv.length !== 3 || !["scan", "review"].includes(argv[0]) || argv[1] !== "--config" || !argv[2])
      throw new Error("GitLab 命令只接受 scan 或 review 和配置路径");
    const configFile = resolve(HOME, argv[2]);
    const script = join(import.meta.dirname, argv[0] === "scan" ? "poll.ts" : "run.ts");
    if (argv[0] === "scan") return [process.execPath, script, "--config", configFile];
    const config = loadConfig(configFile);
    if (
      (turn.model !== undefined && turn.model !== config.model) ||
      (turn.effort !== undefined && turn.effort !== config.effort)
    )
      throw new Error("模型配置与执行参数不一致");
    return [
      process.execPath,
      script,
      "--config",
      configFile,
      "--model",
      config.model,
      ...(config.effort === undefined ? [] : ["--effort", config.effort]),
    ];
  },
  read: command.read,
} satisfies Adapter;
