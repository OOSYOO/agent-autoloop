import { resolve, join } from "node:path";
import { HOME } from "../../host/home.ts";
import type { Adapter } from "../../worker/agents.ts";
import command from "../command/agent.ts";
export default {
  command(turn) {
    const argv = turn.command ?? [];
    if (argv.length !== 3 || !["scan", "review"].includes(argv[0]) || argv[1] !== "--config" || !argv[2])
      throw new Error("飞书请求命令只接受 scan 或 review 和配置路径");
    return [
      process.execPath,
      join(import.meta.dirname, "review-runtime.ts"),
      argv[0],
      "--config",
      resolve(HOME, argv[2]),
    ];
  },
  read: command.read,
} satisfies Adapter;
