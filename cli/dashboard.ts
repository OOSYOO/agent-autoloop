import { loadConfig } from "../dashboard/src/config.ts";
import { createHubClient } from "../dashboard/src/hub-client.ts";
import { createDashboardServer } from "../dashboard/src/server.ts";
export function dashboard() {
  const raw = process.env.PORT ?? "3352";
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT 必须是 1–65535 的端口");
  const client = createHubClient(loadConfig());
  const server = createDashboardServer({ hubClient: client });
  const stop = () => {
    client.close();
    server.close();
    server.closeAllConnections();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  server.once("close", () => {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  });
  server.on("error", () => {
    stop();
    console.error("看板启动失败，请检查端口是否被占用");
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () =>
    console.log(
      `本地任务看板：http://127.0.0.1:${port}\n退出后任务仍会继续。更新前请先退出看板，更新后重新启动并重新加载页面。`,
    ),
  );
}
