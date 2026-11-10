"use client";

import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";

const subscribe = () => () => {};

export default function ThemeToggle() {
  const mounted = useSyncExternalStore(subscribe, () => true, () => false);
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = !mounted || resolvedTheme !== "light";
  const label = isDark ? "切换到浅色模式" : "切换到深色模式";

  return <Button type="button" variant="ghost" aria-label={label} title={label} disabled={!mounted} onClick={() => setTheme(isDark ? "light" : "dark")} className="w-full justify-start group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:self-center group-data-[collapsible=icon]:p-0">
    {isDark ? <Sun data-icon="inline-start" /> : <Moon data-icon="inline-start" />}
    <span className="group-data-[collapsible=icon]:hidden">{isDark ? "Light · 浅色模式" : "Dark · 深色模式"}</span>
  </Button>;
}
