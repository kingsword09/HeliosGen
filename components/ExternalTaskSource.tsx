import { Badge } from "@/components/ui/badge";
import { externalTaskSource } from "@/lib/externalTaskSource";
import type { ExternalConnection, ExternalJob } from "@/lib/integrations";

export default function ExternalTaskSource({ job, clients }: { job: ExternalJob; clients: ExternalConnection[] }) {
  const { connectionName, sourceName, description } = externalTaskSource(job, clients);
  return <div className="flex min-w-0 flex-1 flex-col items-start gap-1" data-task-source>
    <span className="w-full truncate text-xs font-medium" title={`授权连接：${connectionName}`}>连接：{connectionName}</span>
    <Badge variant="outline" className="max-w-full" title={description}><span className="truncate">来源：{sourceName}</span></Badge>
  </div>;
}
