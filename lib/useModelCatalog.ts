"use client";

import { useEffect } from "react";
import { create } from "zustand";
import { buildModelCatalog } from "./modelCatalog";
import { validateProviderConfig, type ProviderConfig, type PublicProviderSettings } from "./providerConfig";
import { loadModelProviders } from "./providers";

const useCatalogStore = create(() => ({ catalog: buildModelCatalog() }));
let pending: Promise<void> | undefined;
let loaded = false;
let revision = 0;
let latestSource: ProviderConfig | PublicProviderSettings | undefined;

export function setModelCatalog(config: ProviderConfig | PublicProviderSettings) {
  revision += 1;
  loaded = true;
  latestSource = config;
  const backendIds = Object.entries(loadModelProviders()).filter(([, backend]) => backend !== "custom").map(([id]) => id);
  useCatalogStore.setState({ catalog: buildModelCatalog(config, backendIds) });
}

export function getModelCatalog() {
  return useCatalogStore.getState().catalog;
}

export function refreshModelCatalog(): Promise<void> {
  if (pending) return pending;
  const requestedRevision = revision;
  pending = fetch("/api/settings/provider", { cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) throw new Error("Could not load model catalog.");
      const data = await response.json();
      if (requestedRevision === revision) setModelCatalog({ ...data, defaultProviderIds: data.defaultProviderIds ?? {}, providers: data.providers.map((provider: PublicProviderSettings["providers"][number]) => ({ ...provider, config: validateProviderConfig(provider.config) })) });
    })
    .finally(() => { pending = undefined; });
  return pending;
}

export function useModelCatalog() {
  const catalog = useCatalogStore((state) => state.catalog);
  useEffect(() => {
    if (!loaded) void refreshModelCatalog().catch(() => {});
    const update = () => { if (latestSource) setModelCatalog(latestSource); };
    window.addEventListener("aiui-providers-changed", update);
    return () => window.removeEventListener("aiui-providers-changed", update);
  }, []);
  return catalog;
}
