"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, ImagePlus, MessageSquare, Package, RefreshCw, Star, Trash2, Upload, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { assetRequest, useAssetDrafts, type SharedAsset } from "@/lib/sharedAssets";
import { thumbSrc } from "@/lib/galleryUtils";
import { useWorkflowStore } from "@/lib/store";
import { useSpaceSync } from "@/lib/useSpaceSync";

interface AssetPage { items: SharedAsset[]; total: number; hasMore: boolean }

export default function AssetsPage() {
  const router = useRouter();
  const [items, setItems] = useState<SharedAsset[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  const [favorite, setFavorite] = useState(false);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<SharedAsset | null>(null);
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const [workflowId, setWorkflowId] = useState("new");
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const spaces = useWorkflowStore((state) => state.spaces);
  const workflowSync = useSpaceSync();

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true); setError("");
      try {
        const params = new URLSearchParams({ q: query, type: kind, favorite: String(favorite), page: String(page) });
        const data = await assetRequest<AssetPage>(`/api/assets?${params}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setItems((previous) => page === 0 ? data.items : [...previous, ...data.items.filter((item) => !previous.some((entry) => entry.id === item.id))]);
        setTotal(data.total); setHasMore(data.hasMore);
      } catch (failure) { if (!controller.signal.aborted) setError((failure as Error).message); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [page, query, kind, favorite, revision]);

  function reload() { setPage(0); setRevision((value) => value + 1); }
  function openAsset(item: SharedAsset) { setSelected(item); setTitle(item.title); setTags(item.tags.join(", ")); setWorkflowId("new"); setConfirmRemoval(false); setError(""); }

  async function uploadFiles(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true); setError("");
    try {
      for (const file of Array.from(files)) {
        if (!/^(image|video)\//.test(file.type)) throw new Error("仅支持图片和视频文件");
        if (file.size > 100 * 1024 * 1024) throw new Error(`${file.name} 超过 100 MB`);
        const response = await fetch("/api/upload-asset", { method: "POST", headers: { "Content-Type": file.type }, body: file });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "上传失败");
        await assetRequest("/api/assets", { method: "POST", body: JSON.stringify({ url: data.cdnUrl, title: file.name }) });
      }
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); reload(); if (inputRef.current) inputRef.current.value = ""; }
  }

  async function updateAsset(item: SharedAsset, fields: object) {
    setBusy(true); setError("");
    try {
      await assetRequest("/api/assets", { method: "PATCH", body: JSON.stringify({ id: item.id, ...fields }) });
      setItems((previous) => previous.map((entry) => entry.id === item.id ? { ...entry, ...fields } : entry));
      setSelected((previous) => previous?.id === item.id ? { ...previous, ...fields } : previous);
      reload();
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }

  async function removeAsset() {
    if (!selected) return;
    setBusy(true); setError("");
    try { await assetRequest("/api/assets", { method: "DELETE", body: JSON.stringify({ id: selected.id }) }); setSelected(null); reload(); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }

  function useInWorkflow() {
    if (!selected || !workflowSync.ready) return;
    const store = useWorkflowStore.getState();
    if (workflowId === "new") store.createSpace(`${selected.title} · Workflow`);
    else if (store.spaces.some((space) => space.id === workflowId)) store.switchSpace(workflowId);
    else { setError("该工作流已不存在，请重新选择"); return; }
    const current = useWorkflowStore.getState();
    const right = current.nodes.reduce((maximum, node) => Math.max(maximum, node.position.x + (node.measured?.width ?? 300)), -200);
    current.addNode({ id: crypto.randomUUID(), type: selected.mediaType === "image" ? "imageInputNode" : "videoInputNode", position: { x: right + 100, y: 100 }, data: { label: selected.title, ...(selected.mediaType === "image" ? { inputImage: selected.url, r2Url: selected.url } : { videoUrl: selected.url }) } });
    router.push(`/workflow/${current.activeSpaceId}`);
  }

  function reuse(target: "chat" | "generation") {
    if (!selected || selected.mediaType !== "image") return;
    const state = useAssetDrafts.getState();
    if (target === "chat" && state.chat.length >= 16 && !state.chat.includes(selected.url)) { setError("Chat 最多附加 16 张图片"); return; }
    state.add(target, [selected.url]);
    router.push(target === "chat" ? "/chat" : "/gallery?tab=images");
  }

  return <main className="flex min-h-0 flex-1 flex-col text-foreground">
    <header className="flex shrink-0 flex-col gap-5 border-b p-6">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="flex items-center gap-3 text-2xl font-semibold"><Package className="size-6" />素材库</h1><p className="mt-2 text-sm text-muted-foreground">上传与生成结果自动汇集，供图片、视频、Chat 和 Workflow 共用。</p></div><div className="flex gap-2"><Button variant="outline" size="icon" aria-label="刷新素材库" onClick={reload} disabled={loading}><RefreshCw /></Button><Button onClick={() => inputRef.current?.click()} disabled={busy}><Upload data-icon="inline-start" />{busy ? "处理中…" : "导入素材"}</Button><input ref={inputRef} type="file" accept="image/*,video/*" multiple className="hidden" onChange={(event) => void uploadFiles(event.target.files)} /></div></div>
      <div className="flex flex-wrap items-center gap-3"><Input className="min-w-40 flex-1" aria-label="搜索素材" placeholder="搜索名称、提示词、模型或标签…" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} /><NativeSelect aria-label="素材类型" value={kind} onChange={(event) => { setKind(event.target.value); setPage(0); }}><NativeSelectOption value="">所有类型</NativeSelectOption><NativeSelectOption value="image">图片</NativeSelectOption><NativeSelectOption value="video">视频</NativeSelectOption></NativeSelect><Button variant={favorite ? "secondary" : "outline"} aria-pressed={favorite} onClick={() => { setFavorite(!favorite); setPage(0); }}><Star data-icon="inline-start" />收藏</Button><span className="text-sm text-muted-foreground">{total} 项</span></div>
    </header>
    <div className="min-h-0 flex-1 overflow-auto p-6">
      {error && <p role="alert" className="mb-4 text-sm text-destructive">{error}</p>}
      {loading && items.length === 0 ? <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">{Array.from({ length: 8 }, (_, index) => <Skeleton key={index} className="aspect-square rounded-xl" />)}</div> : items.length === 0 ? <Empty className="h-full"><EmptyHeader><EmptyMedia variant="icon"><Package /></EmptyMedia><EmptyTitle>{query || kind || favorite ? "没有匹配的素材" : "你的共享素材库"}</EmptyTitle><EmptyDescription>导入图片或视频，或者完成一次生成。点击素材查看详情，并复用到其他功能。</EmptyDescription></EmptyHeader><Button variant="outline" onClick={() => inputRef.current?.click()} disabled={busy}><Upload data-icon="inline-start" />导入素材</Button></Empty> : <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">{items.map((item) => <article key={item.id} className="group overflow-hidden rounded-xl border bg-card">
        <button className="relative flex aspect-square w-full items-center justify-center overflow-hidden bg-muted" onClick={() => openAsset(item)} aria-label={`查看 ${item.title}`}>{item.mediaType === "image" ? <img loading="lazy" src={thumbSrc(item.url, 512)} alt={item.title} className="size-full object-contain transition-transform group-hover:scale-105" /> : <video src={item.url} preload="metadata" muted className="size-full object-contain" />}<Badge variant="secondary" className="absolute bottom-2 left-2">{item.mediaType === "image" ? "图片" : "视频"} · {item.source === "generation" ? "生成" : "上传"}</Badge></button>
        <div className="flex items-center gap-2 p-3"><button onClick={() => openAsset(item)} className="min-w-0 flex-1 text-left"><p className="truncate text-sm font-medium">{item.title}</p><p className="truncate text-xs text-muted-foreground">{item.prompt || item.tags.join(" · ") || new Date(item.created_at).toLocaleString()}</p></button><Button variant="ghost" size="icon-sm" aria-label={item.favorite ? "取消收藏" : "收藏素材"} aria-pressed={item.favorite} disabled={busy} onClick={() => void updateAsset(item, { favorite: !item.favorite })}><Star className={item.favorite ? "fill-current" : ""} /></Button></div>
      </article>)}</div>}
      {hasMore && <div className="mt-6 flex justify-center"><Button variant="outline" disabled={loading} onClick={() => setPage((value) => value + 1)}>{loading ? "加载中…" : "加载更多"}</Button></div>}
    </div>
    <Dialog open={selected !== null} onOpenChange={(open) => { if (!open && !busy) setSelected(null); }}><DialogContent className="max-h-[90dvh] overflow-auto sm:max-w-3xl"><DialogHeader><DialogTitle>素材详情</DialogTitle><DialogDescription>素材链接直接复用，不重复复制文件。移出素材库不影响原图库或工作流。</DialogDescription></DialogHeader>{selected && <div className="flex flex-col gap-5">
      <div className="flex max-h-80 items-center justify-center overflow-hidden rounded-lg bg-muted">{selected.mediaType === "image" ? <img src={selected.url} alt={selected.title} className="max-h-80 max-w-full object-contain" /> : <video src={selected.url} controls className="max-h-80 max-w-full" />}</div>
      <div className="grid gap-4 sm:grid-cols-2"><Field><FieldLabel htmlFor="asset-title">名称</FieldLabel><Input id="asset-title" value={title} maxLength={500} onChange={(event) => setTitle(event.target.value)} /></Field><Field><FieldLabel htmlFor="asset-tags">标签</FieldLabel><Input id="asset-tags" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="用逗号分隔，例如：参考, 产品" /></Field></div>
      {selected.prompt && <p className="max-h-28 overflow-auto whitespace-pre-wrap text-sm text-muted-foreground">{selected.prompt}</p>}
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={() => void updateAsset(selected, { title: title.trim() || "未命名素材", tags: [...new Set(tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean))] })}>保存名称与标签</Button><Button variant="outline" render={<a href={`/api/download?url=${encodeURIComponent(selected.url)}&filename=${encodeURIComponent(selected.title)}`} />}><Download data-icon="inline-start" />下载原文件</Button><Button variant="outline" disabled={selected.mediaType !== "image"} onClick={() => reuse("generation")}><ImagePlus data-icon="inline-start" />作为生图参考</Button><Button variant="outline" disabled={selected.mediaType !== "image"} onClick={() => reuse("chat")}><MessageSquare data-icon="inline-start" />附加到 Chat</Button></div>
      {selected.mediaType === "video" && <p className="text-xs text-muted-foreground">视频可加入 Workflow，也可在视频生成的素材选择器中复用。Chat 目前仅支持图片附件。</p>}
      <Field><FieldLabel htmlFor="asset-workflow">添加到 Workflow</FieldLabel><div className="flex flex-wrap gap-2"><NativeSelect id="asset-workflow" value={workflowId} onChange={(event) => setWorkflowId(event.target.value)}><NativeSelectOption value="new">创建新工作流</NativeSelectOption>{spaces.map((space) => <NativeSelectOption key={space.id} value={space.id}>{space.name}</NativeSelectOption>)}</NativeSelect><Button disabled={!workflowSync.ready} onClick={useInWorkflow}><Workflow data-icon="inline-start" />{workflowSync.ready ? "添加输入节点" : workflowSync.status === "error" ? "工作流读取失败" : "正在读取工作流…"}</Button></div><FieldDescription>添加独立素材输入节点，保留现有节点与连接；连接生成器后即可作为参考使用。</FieldDescription></Field>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4"><p className="text-xs text-muted-foreground">{selected.model || "本地上传"} · {new Date(selected.created_at).toLocaleString()}</p><Button variant={confirmRemoval ? "destructive" : "ghost"} disabled={busy} onClick={() => confirmRemoval ? void removeAsset() : setConfirmRemoval(true)}><Trash2 data-icon="inline-start" />{confirmRemoval ? "确认移出（不删文件）" : "移出素材库"}</Button></div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>}</DialogContent></Dialog>
  </main>;
}
