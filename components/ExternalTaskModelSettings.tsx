"use client";

import { useEffect, useState } from "react";
import { ModelEditor } from "@/components/ProviderModelsPanel";
import { validateProviderConfig, withProviderModels, type ProviderConfig, type PublicProviderSettings } from "@/lib/providerConfig";
import type { ProviderModel } from "@/lib/providerModelConfig";
import { setModelCatalog } from "@/lib/useModelCatalog";

export default function ExternalTaskModelSettings({ modelId, onClose, onError }: { modelId: string; onClose: () => void; onError: (error: string) => void }) {
  const [settings, setSettings] = useState<{ config: ProviderConfig; model: ProviderModel } | null>(null);
  const identity = /^provider-model:([a-zA-Z0-9_-]+):([a-zA-Z0-9_-]+)$/.exec(modelId);
  const providerId = identity?.[1];
  const configuredModelId = identity?.[2];

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch("/api/settings/provider", { cache: "no-store", signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "无法读取模型参数");
        const config = (data as PublicProviderSettings).providers.find((provider) => provider.config.id === providerId)?.config;
        const model = config?.models.find((entry) => entry.id === configuredModelId && entry.kind === "image");
        if (!config || !model) throw new Error("模型已删除，请重新选择模型");
        if (!controller.signal.aborted) setSettings({ config: validateProviderConfig(config), model });
      } catch (failure) {
        if (!controller.signal.aborted) { onError(failure instanceof Error ? failure.message : "无法读取模型参数"); onClose(); }
      }
    }
    void load();
    return () => controller.abort();
  }, [providerId, configuredModelId, onError, onClose]);

  async function save(model: ProviderModel) {
    const response = await fetch("/api/settings/provider", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "无法读取当前模型配置");
    const latest = (data as PublicProviderSettings).providers.find((provider) => provider.config.id === providerId)?.config;
    if (!latest?.models.some((entry) => entry.id === model.id)) throw new Error("模型已删除，请重新选择模型");
    const config = withProviderModels(validateProviderConfig(latest), latest.models.map((entry) => entry.id === model.id ? model : entry));
    const result = await fetch("/api/settings/provider", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config }) });
    const saved = await result.json();
    if (!result.ok) throw new Error(saved.error || "无法保存模型参数");
    setModelCatalog(saved);
    window.dispatchEvent(new Event("aiui-providers-changed"));
    onClose();
  }

  return settings ? <ModelEditor initial={settings.model} config={settings.config} onApply={save} onCancel={onClose} /> : null;
}
