"use client";

import { useEffect, useRef, useState } from "react";
import { Download, Upload, FolderOpen, ShieldAlert, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { assetRequest } from "@/lib/sharedAssets";
import { refreshModelCatalog } from "@/lib/useModelCatalog";
import { useTheme } from "next-themes";

const PREFERENCE_KEYS = ["aiui-model-providers", "aiui-azure-endpoints", "aiui-azure-base-url", "aiui-azure-text-deployment", "aiui-azure-text-model", "heliosgen-theme"];
interface Preview { providers: { name: string; modelCount: number; conflict: boolean; hasKey: boolean }[]; models: number; conflicts: number; keys: number; hasAzureKey: boolean; preferences: number }
interface SaveHandle { createWritable: () => Promise<{ write: (blob: Blob) => Promise<void>; close: () => Promise<void> }> }

export default function ConfigTransferPanel() {
  const { setTheme } = useTheme();
  const [nativeSave, setNativeSave] = useState<boolean | null>(null);
  const [includeKeys, setIncludeKeys] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [backup, setBackup] = useState<unknown>();
  const [preview, setPreview] = useState<Preview>();
  const [filename, setFilename] = useState("");
  const [mode, setMode] = useState("merge");
  const [confirmed, setConfirmed] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { assetRequest<{ nativeSave: boolean }>("/api/settings/transfer").then((data) => setNativeSave(data.nativeSave)).catch((failure) => setError(failure.message)); }, []);

  async function exportConfig() {
    setError(""); setNotice(""); setBusy(true);
    try {
      let handle: SaveHandle | undefined;
      const picker = (window as unknown as { showSaveFilePicker?: (options: object) => Promise<SaveHandle> }).showSaveFilePicker;
      if (!nativeSave && picker) handle = await picker.call(window, { suggestedName: "heliosgen-config.json", types: [{ description: "HeliosGen 配置", accept: { "application/json": [".json"] } }] });
      const preferences = Object.fromEntries(PREFERENCE_KEYS.flatMap((key) => { const value = localStorage.getItem(key); return value === null ? [] : [[key, value]]; }));
      const data = await assetRequest<{ cancelled?: boolean; saved?: boolean; path?: string; filename: string; backup: unknown }>("/api/settings/transfer", { method: "POST", body: JSON.stringify({ action: "export", includeKeys, native: nativeSave, preferences }) });
      if (data.cancelled) return;
      if (data.saved) { setNotice(`已导出到 ${data.path}`); return; }
      const blob = new Blob([JSON.stringify(data.backup, null, 2)], { type: "application/json" });
      if (handle) { const writer = await handle.createWritable(); await writer.write(blob); await writer.close(); }
      else { const location = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = location; anchor.download = data.filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(location), 1000); }
      setNotice("配置已导出。");
    } catch (failure) { if ((failure as Error).name !== "AbortError") setError((failure as Error).message); }
    finally { setBusy(false); }
  }

  async function readConfig(file?: File) {
    if (!file) return;
    setBusy(true); setError(""); setNotice(""); setPreview(undefined); setBackup(undefined); setConfirmed(false);
    try {
      if (file.size > 4 * 1024 * 1024) throw new Error("配置文件最大 4 MB");
      const value: unknown = JSON.parse(await file.text());
      const data = await assetRequest<Preview>("/api/settings/transfer", { method: "POST", body: JSON.stringify({ action: "preview", backup: value }) });
      setBackup(value); setPreview(data); setFilename(file.name);
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  }

  async function importConfig() {
    if (!preview || !confirmed) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const data = await assetRequest<{ preferences: Record<string, string> }>("/api/settings/transfer", { method: "POST", body: JSON.stringify({ action: "import", backup, mode }) });
      for (const [key, value] of Object.entries(data.preferences)) {
        if ((key === "aiui-model-providers" || key === "aiui-azure-endpoints") && mode === "merge") localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) || "{}"), ...JSON.parse(value) }));
        else localStorage.setItem(key, value);
      }
      if (data.preferences["heliosgen-theme"]) setTheme(data.preferences["heliosgen-theme"]);
      window.dispatchEvent(new CustomEvent("aiui-providers-changed"));
      await refreshModelCatalog();
      setNotice("配置已导入，模型目录已刷新。重新打开设置即可查看；未包含的密钥请在服务商页面补充。本机登录与外部互联不受影响。");
      setPreview(undefined); setBackup(undefined); setConfirmed(false);
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }

  return <section className="flex flex-col gap-6 text-foreground">
    <div><h3 className="text-lg font-semibold">配置迁移</h3><p className="mt-2 text-sm text-muted-foreground">在另一台电脑复用服务商、模型、参数预设、自定义映射及 Azure 部署设置。不会导出图片、对话、工作流或本机登录凭证；工作流及其素材可单独导出 ZIP。</p></div>
    <Field orientation="horizontal"><div className="flex flex-1 flex-col gap-1"><FieldLabel htmlFor="export-keys">包含 API 密钥</FieldLabel><FieldDescription>默认关闭。开启后密钥以明文写入，请仅保存到可信目录，勿分享文件。</FieldDescription></div><Switch id="export-keys" checked={includeKeys} onCheckedChange={setIncludeKeys} disabled={busy} /></Field>
    {includeKeys && <p className="flex items-center gap-2 text-sm text-destructive"><ShieldAlert className="size-4 shrink-0" />导出的文件含敏感密钥，不含 Codex OAuth 或 Agent 令牌。</p>}
    <div className="flex flex-wrap items-center gap-3"><Button onClick={exportConfig} disabled={busy || nativeSave === null}><FolderOpen data-icon="inline-start" />选择目录并导出</Button><span className="text-xs text-muted-foreground">{nativeSave ? "系统保存对话框，可选目录和文件名" : "浏览器支持时选择保存位置，否则使用下载目录"}</span></div>
    <Separator />
    <div className="flex items-center justify-between gap-4"><div><h4 className="font-medium">导入配置</h4><p className="mt-1 text-sm text-muted-foreground">先检查内容，再确认合并或替换；读取文件不会修改现有配置。</p></div><Button variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}><Upload data-icon="inline-start" />选择文件</Button><input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={(event) => void readConfig(event.target.files?.[0])} /></div>
    {preview && <div className="flex flex-col gap-4 rounded-xl border p-4">
      <p className="break-all text-sm font-medium">{filename}</p><p className="text-sm text-muted-foreground">{preview.providers.length} 个服务商 · {preview.models} 个模型 · {preview.conflicts} 个同 ID 冲突 · {preview.keys} 个密钥{preview.hasAzureKey ? " + Azure 密钥" : ""}</p>
      <ul className="flex max-h-48 flex-col gap-2 overflow-auto text-sm">{preview.providers.map((provider, index) => <li key={index} className="flex justify-between gap-3"><span className="truncate">{provider.name}</span><span className="shrink-0 text-muted-foreground">{provider.modelCount} 模型{provider.conflict ? " · 将覆盖配置" : " · 新增"}</span></li>)}</ul>
      <Field><FieldLabel htmlFor="import-mode">导入方式</FieldLabel><NativeSelect id="import-mode" value={mode} onChange={(event) => { setMode(event.target.value); setConfirmed(false); }} disabled={busy}><NativeSelectOption value="merge">合并：保留其他服务商，同 ID 配置覆盖</NativeSelectOption><NativeSelectOption value="replace">替换：移除文件中未包含的服务商</NativeSelectOption></NativeSelect><FieldDescription>未导出密钥时，同 ID 服务商保留本机密钥，新服务商需要填写密钥。替换可能使旧工作流的模型引用失效。</FieldDescription></Field>
      <Field orientation="horizontal"><Switch id="confirm-import" checked={confirmed} onCheckedChange={setConfirmed} disabled={busy} /><FieldLabel htmlFor="confirm-import">我已核对内容，确认{mode === "replace" ? "替换现有服务商列表" : "合并并覆盖同 ID 配置"}</FieldLabel></Field>
      <Button disabled={busy || !confirmed} onClick={importConfig}><Download data-icon="inline-start" />确认导入</Button>
    </div>}
    {busy && <p className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在处理…</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}{notice && <p role="status" className="break-all text-sm text-muted-foreground">{notice}</p>}
  </section>;
}
