"use client";

import { useState } from "react";
import { ImagePlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MediaPickerModal } from "@/components/MediaPickerModal";
import { useAssetDrafts } from "@/lib/sharedAssets";

export default function ChatAssets({ disabled = false }: { disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const urls = useAssetDrafts((state) => state.chat);
  const add = useAssetDrafts((state) => state.add);
  const remove = useAssetDrafts((state) => state.remove);
  return <div className="mb-3 flex flex-wrap items-center gap-2">
    <Button variant="outline" size="sm" disabled={disabled} onClick={() => setOpen(true)}><ImagePlus data-icon="inline-start" />素材库{urls.length ? ` · ${urls.length}/16` : ""}</Button>
    {urls.map((url) => <div key={url} className="relative"><img src={url} alt="待发送图片" className="size-16 rounded-lg border object-cover" /><Button variant="secondary" size="icon-xs" className="absolute -top-1 -right-1" aria-label="移除图片附件" disabled={disabled} onClick={() => remove("chat", url)}><X /></Button></div>)}
    {urls.length > 0 && <p className="basis-full text-xs text-muted-foreground">图片随下一条消息发送，请选择支持视觉的模型；暂不支持视频附件。</p>}
    <MediaPickerModal open={open} mediaKind="image" onClose={() => setOpen(false)} onPickUrl={(url) => { if (urls.length < 16) add("chat", [url]); }} onDeselect={(url) => remove("chat", url)} selectedUrls={urls} maxCount={16} />
  </div>;
}
