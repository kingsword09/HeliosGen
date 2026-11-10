"use client";
import { useEffect, useState } from "react";
import SettingsModal from "@/components/SettingsModal";
import Toaster from "@/components/Toaster";
import DesktopLinkHandler from "@/components/DesktopLinkHandler";
import ExternalIntegrationBridge from "@/components/ExternalIntegrationBridge";
import { useWorkflowStore } from "@/lib/store";

export default function GlobalModals() {
  const settingsOpen    = useWorkflowStore((s) => s.settingsOpen);
  const setSettingsOpen = useWorkflowStore((s) => s.setSettingsOpen);
  const [integrationSettings, setIntegrationSettings] = useState(false);

  useEffect(() => {
    const open = () => { setIntegrationSettings(true); setSettingsOpen(true); };
    window.addEventListener("helios-open-integration-settings", open);
    return () => window.removeEventListener("helios-open-integration-settings", open);
  }, [setSettingsOpen]);

  return (
    <>
      <DesktopLinkHandler />
      <ExternalIntegrationBridge />
      {settingsOpen && <SettingsModal key={integrationSettings ? "integrations" : "normal"} initialSection={integrationSettings ? "integrations" : undefined} onClose={() => { setSettingsOpen(false); setIntegrationSettings(false); }} />}
      <Toaster />
    </>
  );
}
