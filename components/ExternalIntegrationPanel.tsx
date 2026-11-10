"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Check, Copy, Download, History, Inbox, Link2, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { integrationSettings } from "@/lib/integrations";
import { externalTaskCounts, useExternalTaskStore } from "@/lib/externalTaskStore";

export default function ExternalIntegrationPanel({ onOpenTask }: { onOpenTask?: () => void }) {
  const overview = useExternalTaskStore((state) => state.overview);
  const setOverview = useExternalTaskStore((state) => state.setOverview);
  const [name, setName] = useState("本机绘图助手");
  const [agent, setAgent] = useState("shared");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const installed = overview?.installedAgents?.includes(agent) ?? false;
  const counts = externalTaskCounts(overview?.jobs ?? []);
  const refresh = useCallback(() => {
    void integrationSettings().then(setOverview).catch((failure: Error) => setError(failure.message));
  }, [setOverview]);
  useEffect(() => {
    const controller = new AbortController();
    void integrationSettings(undefined, controller.signal).then(setOverview).catch((failure: Error) => { if (!controller.signal.aborted) setError(failure.message); });
    window.addEventListener("helios-integrations-changed", refresh);
    return () => { controller.abort(); window.removeEventListener("helios-integrations-changed", refresh); };
  }, [refresh, setOverview]);

  async function action(fields: Record<string, unknown>) {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try { setOverview(await integrationSettings(fields)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "操作失败"); }
    finally { setBusy(false); }
  }

  async function install(clientId: string) {
    if (busy || installed) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await integrationSettings<{ cliPath: string; skillPath: string; installedAgents: string[] }>({ action: "install", clientId, agent });
      const current = useExternalTaskStore.getState().overview;
      if (current) setOverview({ ...current, installedAgents: result.installedAgents });
      setNotice(`已安装 CLI：${result.cliPath}；Skill：${result.skillPath}。请确保 ~/.local/bin 位于 PATH，并在对应 Agent 中新开会话。未改动其他 Skill 或 Hook。`);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "安装失败"); }
    finally { setBusy(false); }
  }

  async function copy(command: string) {
    try { await navigator.clipboard.writeText(command); setNotice("命令已复制"); }
    catch { setNotice(`请复制：${command}`); }
  }

  function openInbox(tab: "active" | "processed") {
    useExternalTaskStore.getState().openPanel(tab);
    onOpenTask?.();
  }

  return <FieldGroup className="provider-settings">
    <FieldSet>
      <FieldLegend className="flex items-center gap-2"><Link2 className="size-4" />外部 Chat / Agent 互联</FieldLegend>
      <FieldDescription>在外部 Chat / Agent 中继续对话，调用当前应用生成图片。支持通过 CLI / Skill 接入，不限于 Rex。只传提示词和参考图，不同步完整聊天，不向 Agent 暴露服务商 Key。</FieldDescription>
      <Field orientation="horizontal"><FieldLabel htmlFor="external-enabled">允许本机 Agent 连接 · {overview?.enabled ? "已开启" : "已关闭"}</FieldLabel><Switch id="external-enabled" checked={overview?.enabled ?? false} disabled={busy || !overview} onCheckedChange={(enabled) => action({ action: "enable", enabled })} /></Field>
      <FieldDescription>仅支持与应用运行在同一台电脑、同一用户账户的 Agent；应用必须保持运行。关闭连接或撤销授权不会取消已经提交给服务商的任务。</FieldDescription>
    </FieldSet>

    <FieldSet data-task-summary><FieldLegend className="flex items-center gap-2"><Inbox className="size-4" />消息中心</FieldLegend>
      <FieldDescription>在右侧消息中心集中审批外部请求、查看生成结果与管理已处理消息。</FieldDescription>
      <div className="flex flex-wrap items-center gap-2" aria-label="外部任务概览">
        <Badge variant={counts.pending ? "secondary" : "outline"}>待确认 {counts.pending}</Badge>
        <Badge variant="outline">进行中 {counts.running}</Badge>
        <Badge variant="outline">已处理 {counts.processed}</Badge>
      </div>
      <div className="flex flex-wrap items-center gap-2"><Button disabled={!overview} onClick={() => openInbox(counts.active || !counts.processed ? "active" : "processed")}><Inbox data-icon="inline-start" />打开消息中心<ArrowRight data-icon="inline-end" /></Button><Button variant="outline" disabled={!overview} onClick={() => openInbox("processed")}><History data-icon="inline-start" />查看已处理</Button></div>
      <FieldDescription>已完成、失败和拒绝的消息可逐条移除，或在消息中心统一清理；不会删除任务记录和生成图片。</FieldDescription>
    </FieldSet>

    <FieldSet><FieldLegend>连接与授权</FieldLegend><FieldGroup>
      <Field><FieldLabel htmlFor="external-name">连接名称（备注）</FieldLabel><Input id="external-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={100} placeholder="例如 本机绘图助手、Codex 专用连接" /><FieldDescription>名称是授权连接的备注，不代表实际调用来源。多个 Agent 可共用连接；需要独立管理权限时，请分别创建连接。</FieldDescription></Field>
      <div className="flex flex-wrap items-center gap-2"><Button disabled={busy || !overview?.enabled || !name.trim()} onClick={() => action({ action: "pair", name })}><Link2 data-icon="inline-start" />创建连接</Button><Button variant="outline" disabled={busy} onClick={refresh}><RefreshCw data-icon="inline-start" />刷新</Button></div>
      <FieldDescription>新连接默认每次生成都需要在消息中心确认。连接凭据保存在应用私有目录，不需要复制 Token。</FieldDescription>
      {overview?.clients.map((client) => <div key={client.id} className="flex flex-col gap-3 rounded-lg border border-border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm">{client.name}</p><Button variant="destructive" size="icon-sm" disabled={busy} aria-label={`撤销连接 ${client.name}`} title="撤销连接" onClick={() => { if (window.confirm(`撤销「${client.name}」？尚未批准的任务会被拒绝，已开始的生成不会自动取消。`)) void action({ action: "revoke", clientId: client.id }); }}><Trash2 data-icon="inline-start" /></Button></div>
        <Field orientation="horizontal"><FieldLabel htmlFor={`auto-${client.id}`}>无需逐次确认 · {client.autoApprove ? "已允许" : "未允许"}</FieldLabel><Switch id={`auto-${client.id}`} checked={client.autoApprove} disabled={busy} onCheckedChange={(autoApprove) => { if (!autoApprove || window.confirm("允许此连接自动提交图片生成？调用配置的服务商可能产生费用。")) void action({ action: "policy", clientId: client.id, autoApprove }); }} /></Field>
        <div className="flex flex-wrap items-center gap-2"><code className="break-all text-xs">helios --client {client.id} models</code><Button variant="outline" size="icon-sm" aria-label={`复制 ${client.name} 的连接命令`} title="复制连接命令" onClick={() => copy(`helios --client ${client.id} models`)}><Copy data-icon="inline-start" /></Button></div>
        <Field><FieldLabel id={`agent-${client.id}`}>安装到 Agent</FieldLabel><ToggleGroup variant="outline" size="sm" disabled={busy} value={[agent]} onValueChange={(values) => { if (values[0]) setAgent(values[0]); }} aria-labelledby={`agent-${client.id}`} className="flex-wrap"><ToggleGroupItem value="shared">Codex / OpenCode / Pi</ToggleGroupItem><ToggleGroupItem value="claude">Claude Code</ToggleGroupItem></ToggleGroup></Field>
        <div><Button variant="outline" disabled={busy || installed} onClick={() => install(client.id)}>{installed ? <Check data-icon="inline-start" /> : <Download data-icon="inline-start" />}{installed ? "CLI 和 Skill 已安装" : "安装 CLI 和 Helios Skill"}</Button></div>
      </div>)}
      {overview && !overview.clients.length && <FieldDescription>尚无外部连接。开启互联后创建一个连接即可。</FieldDescription>}
    </FieldGroup></FieldSet>

    {notice && <FieldDescription role="status">{notice}</FieldDescription>}
    {error && <Field data-invalid><FieldError role="alert">{error}</FieldError></Field>}
  </FieldGroup>;
}
