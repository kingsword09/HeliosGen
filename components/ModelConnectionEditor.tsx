"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import type { ProviderConfig } from "@/lib/providerConfig";
import { MODEL_PROTOCOL_LABELS, modelRequestUrl, providerModelProtocol, resolveModelConnection } from "@/lib/providerConnection";
import { modelProtocols, type ProviderModel, type ProviderModelConnection } from "@/lib/providerModelConfig";

const AUTH_OPTIONS = [{ id: "provider", label: "自动 / 供应商默认" }, { id: "bearer", label: "Bearer Key" }, { id: "gemini", label: "Gemini Key" }, { id: "anthropic", label: "Anthropic Key" }, { id: "custom", label: "自定义请求头" }] as const;

export default function ModelConnectionEditor({ config, model, onChange, onProtocolChange, onValidationChange }: { config: ProviderConfig; model: ProviderModel; onChange: (connection: ProviderModelConnection) => void; onProtocolChange: (protocol: ProviderModelConnection["protocol"]) => void; onValidationChange: (error: string) => void }) {
  const id = useId();
  const [templateError, setTemplateError] = useState("");
  const [template, setTemplate] = useState(model.connection?.body ? JSON.stringify(model.connection.body, null, 2) : "");
  const connection = model.connection ?? {};
  const protocol = providerModelProtocol(config, model);
  const inherited = providerModelProtocol(config, { kind: model.kind });
  const effective = resolveModelConnection(config, model);
  const path = model.kind === "image" ? effective.imagesPath : model.kind === "text" ? effective.chatPath : effective.videoPath;
  let preview = "请先填写有效的供应商地址";
  try { preview = modelRequestUrl(effective, path, protocol === "gemini" ? (model.apiId || "模型ID").replace(/^models\//, "") : model.apiId || "模型ID"); } catch {}
  function update(field: keyof ProviderModelConnection, value: string) {
    const next = { ...connection };
    if (value === "") delete next[field];
    else Object.assign(next, { [field]: value });
    onChange(next);
  }
  function choose(protocol: ProviderModelConnection["protocol"]) {
    onProtocolChange(protocol);
  }
  const task = protocol === "task";
  const fields: Array<{ key: keyof ProviderModelConnection; label: string; placeholder: string }> = [
    { key: "generatePath", label: model.kind === "text" ? "对话请求路径" : "生成请求路径", placeholder: path },
    ...(model.kind === "image" && protocol === "openai" ? [{ key: "editsPath" as const, label: "参考图编辑路径", placeholder: effective.editsPath }] : []),
    ...(task ? [
      { key: "statusPath" as const, label: "任务轮询路径", placeholder: effective.statusPath },
      { key: "taskIdPath" as const, label: "任务 ID 字段", placeholder: effective.taskIdPath },
      { key: "taskStatePath" as const, label: "任务状态字段", placeholder: effective.taskStatePath },
      { key: "taskOutputPath" as const, label: "任务结果字段", placeholder: effective.taskOutputPath },
      { key: "uploadPath" as const, label: "参考文件上传路径", placeholder: effective.uploadPath || "留空直接发送文件内容" },
      { key: "uploadResultPath" as const, label: "上传结果 URL 字段", placeholder: effective.uploadResultPath },
    ] : []),
  ];
  const prefixField = <Field>
    <FieldLabel htmlFor={`${id}-prefix`}>接口前缀（可选）</FieldLabel>
    <Input id={`${id}-prefix`} value={connection.basePath ?? ""} onChange={(event) => update("basePath", event.target.value)} placeholder={`跟随供应商地址：${new URL(config.baseUrl).pathname || "/"}`} />
    <FieldDescription>不同接口使用不同版本路径时填写，例如 /v1 或 /v1beta；只改路径，不会把 Key 发到其他域名。</FieldDescription>
    {protocol === "gemini" && connection.basePath === undefined && <Button type="button" variant="outline" size="sm" onClick={() => update("basePath", "/v1beta")}>使用 /v1beta 前缀</Button>}
  </Field>;
  return <FieldGroup className="rounded-lg border border-border bg-muted/30 p-3">
    <Field>
      <FieldLabel id={`${id}-protocol`}>接口方式</FieldLabel>
      {model.kind === "video" ? <FieldDescription>异步任务 · 共用供应商连接，可单独调整请求路径。</FieldDescription> : <ToggleGroup aria-labelledby={`${id}-protocol`} variant="outline" size="sm" value={[connection.protocol ?? "inherit"]} onValueChange={(values) => { if (values[0]) choose(values[0] === "inherit" ? undefined : values[0] as ProviderModelConnection["protocol"]); }} className="flex-wrap">
        <ToggleGroupItem value="inherit">跟随供应商</ToggleGroupItem>
        {modelProtocols(model.kind).map((format) => <ToggleGroupItem key={format} value={format}>{MODEL_PROTOCOL_LABELS[format]}</ToggleGroupItem>)}
      </ToggleGroup>}
      <FieldDescription>{connection.protocol ? `${MODEL_PROTOCOL_LABELS[protocol]} · 仅此模型使用，不影响同一供应商的其他模型。` : `默认使用 ${MODEL_PROTOCOL_LABELS[inherited]}。同一供应商的模型接口不同时，在这里单独选择即可。`} 地址和 API Key 共用「{config.name}」，不用重复添加供应商。</FieldDescription>
    </Field>
    {(connection.protocol || model.kind === "video") && prefixField}
    <p className="break-all text-xs text-muted-foreground" aria-label="实际请求地址">POST {preview}</p>
    <details><summary className="cursor-pointer text-sm">路径与认证覆盖（高级，可选）</summary><FieldGroup className="mt-4">
      {!connection.protocol && model.kind !== "video" && prefixField}
      <FieldDescription>留空即继承或使用当前接口的标准路径。Gemini 路径可用 {"{model}"}，任务轮询路径可用 {"{id}"}；路径相对于上面的接口前缀。</FieldDescription>
      {fields.map((field) => <Field key={field.key}><FieldLabel htmlFor={`${id}-${field.key}`}>{field.label}</FieldLabel><Input id={`${id}-${field.key}`} value={String(connection[field.key] ?? "")} onChange={(event) => update(field.key, event.target.value)} placeholder={field.placeholder} /></Field>)}
      <Field><FieldLabel id={`${id}-auth`}>Key 发送方式</FieldLabel><ToggleGroup aria-labelledby={`${id}-auth`} variant="outline" size="sm" value={[connection.authMode ?? "provider"]} onValueChange={(values) => { if (values[0]) onChange({ ...connection, authMode: values[0] as ProviderModelConnection["authMode"] }); }} className="flex-wrap">{AUTH_OPTIONS.map((option) => <ToggleGroupItem key={option.id} value={option.id}>{option.label}</ToggleGroupItem>)}</ToggleGroup><FieldDescription>默认跟随接口原生认证，并保留供应商自定义请求头。若网关要求所有接口都用 Authorization，选 Bearer Key 即可。</FieldDescription></Field>
      {connection.authMode === "custom" && <>
        <Field><FieldLabel htmlFor={`${id}-header`}>认证请求头</FieldLabel><Input id={`${id}-header`} value={connection.authHeader ?? ""} onChange={(event) => update("authHeader", event.target.value)} placeholder="X-API-Key" /></Field>
        <Field><FieldLabel htmlFor={`${id}-auth-prefix`}>Key 前缀（可留空）</FieldLabel><Input id={`${id}-auth-prefix`} value={connection.authPrefix ?? ""} onChange={(event) => onChange({ ...connection, authPrefix: event.target.value })} placeholder="例如 Bearer 后加一个空格" /></Field>
      </>}
      {task && <Field><FieldLabel htmlFor={`${id}-body`}>此模型的任务请求模板（JSON，可选）</FieldLabel><Textarea id={`${id}-body`} value={template} onChange={(event) => {
        const value = event.target.value; setTemplate(value);
        try {
          const body = value.trim() ? JSON.parse(value) : null;
          if (body !== null && (typeof body !== "object" || Array.isArray(body))) throw new Error("模板必须是 JSON 对象。");
          onChange({ ...connection, body }); setTemplateError(""); onValidationChange("");
        } catch { const error = "模板尚不是有效的 JSON 对象，修正或清空后才能保存。"; setTemplateError(error); onValidationChange(error); }
      }} rows={6} /><FieldDescription>{templateError || "支持 {{model}}、{{prompt}}、{{image_urls}} 等占位符，详见 README。清空后使用标准任务请求。"}</FieldDescription></Field>}
    </FieldGroup></details>
  </FieldGroup>;
}
