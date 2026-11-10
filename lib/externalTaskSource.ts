import type { ExternalConnection, ExternalJob } from "@/lib/integrations";

const SOURCE_NAMES = new Map([
  ["codex", "Codex"],
  ["claude", "Claude Code"],
  ["claudecode", "Claude Code"],
  ["opencode", "OpenCode"],
  ["pi", "Pi"],
  ["rex", "Rex 环境"],
]);

export function externalTaskSource(job: ExternalJob, clients: ExternalConnection[]) {
  const connectionName = clients.find((client) => client.id === job.clientId)?.name ?? "已撤销连接";
  const reportedName = job.source?.name?.trim() ?? "";
  const normalizedName = reportedName.toLowerCase().replace(/[\s_-]/g, "");
  const unknown = !normalizedName || ["agent", "unknown"].includes(normalizedName);
  const sourceName = unknown ? "未识别" : SOURCE_NAMES.get(normalizedName) ?? reportedName;
  const description = unknown
    ? "调用方未提供具体 Agent 名称，不能通过连接名称判断来源。"
    : normalizedName === "rex"
      ? "Rex 表示终端运行环境，不代表其中运行的具体 Agent。"
      : "来源名称由调用方提供，仅供参考，不是经过认证的应用身份。";
  return { connectionName, sourceName, description };
}
