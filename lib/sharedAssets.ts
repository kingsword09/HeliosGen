"use client";

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { GalleryItem } from "./galleryUtils";

export interface SharedAsset extends GalleryItem {
  title: string;
  tags: string[];
  favorite: boolean;
}

export async function assetRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", "X-Helios-UI": "1", ...init?.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "操作失败");
  return data as T;
}

interface AssetDrafts {
  chat: string[];
  generation: string[];
  add: (target: "chat" | "generation", urls: string[]) => void;
  remove: (target: "chat" | "generation", url: string) => void;
  clear: (target: "chat" | "generation") => void;
}

export const useAssetDrafts = create<AssetDrafts>()(persist((set) => ({
  chat: [], generation: [],
  add: (target, urls) => set((state) => ({ [target]: [...new Set([...state[target], ...urls])] })),
  remove: (target, url) => set((state) => ({ [target]: state[target].filter((entry) => entry !== url) })),
  clear: (target) => set({ [target]: [] }),
}), { name: "helios-asset-drafts", storage: createJSONStorage(() => sessionStorage) }));
