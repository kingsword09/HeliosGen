"use client";
import { useEffect } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useWorkflowStore, Toast } from "@/lib/store";

const COLORS: Record<Toast["type"], { bg: string; border: string; icon: string }> = {
  error:   { bg: "color-mix(in srgb, var(--destructive) 12%, transparent)",  border: "color-mix(in srgb, var(--destructive) 30%, transparent)",  icon: "var(--destructive)"  },
  success: { bg: "rgb(var(--ui-accent-4ade80-rgb) / 0.10)", border: "rgb(var(--ui-accent-4ade80-rgb) / 0.3)", icon: "rgb(var(--ui-accent-4ade80-rgb) / 0.9)" },
  info:    { bg: "rgb(var(--ui-accent-60a5fa-rgb) / 0.10)", border: "rgb(var(--ui-accent-60a5fa-rgb) / 0.3)", icon: "rgb(var(--ui-accent-60a5fa-rgb) / 0.9)" },
};

const ICONS: Record<Toast["type"], string> = {
  error:   "M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z",
  success: "M20 6 9 17l-5-5",
  info:    "M12 16v-4m0-4h.01M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2z",
};

function DismissButton({ onDismiss }: { onDismiss: (e: React.MouseEvent) => void }) {
  return (
    <button
      onClick={onDismiss}
      style={{
        background: "none", border: "none", cursor: "pointer",
        color: "rgb(var(--ui-ink-rgb) / max(0.3, var(--ui-text-min-opacity)))", padding: "0", flexShrink: 0, lineHeight: 1,
      }}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        <path d="M18 6 6 18M6 6l12 12" />
      </svg>
    </button>
  );
}

// macOS-style rich notification — used when toast has title + preview
function RichToastItem({ toast, onDismiss, onClick }: { toast: Toast; onDismiss: (e: React.MouseEvent) => void; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "14px 14px",
        borderRadius: "14px",
        background: "rgb(var(--ui-tone-1c1c1e-rgb) / 0.96)",
        border: "1px solid rgb(var(--ui-ink-rgb) / 0.1)",
        boxShadow: "0 12px 36px rgb(var(--ui-shadow-rgb)/calc(0.6*var(--ui-shadow-opacity)))",
        backdropFilter: "blur(20px)",
        width: "340px",
        animation: "toastIn 220ms cubic-bezier(0.22,1,0.36,1) both",
        cursor: "pointer",
      }}
    >
      {/* Close button — top right */}
      <button
        onClick={onDismiss}
        style={{
          position: "absolute", top: "8px", right: "8px",
          width: "18px", height: "18px", borderRadius: "50%",
          background: "rgb(var(--ui-ink-rgb) / 0.1)",
          border: "none", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
          color: "rgb(var(--ui-ink-rgb) / max(0.5, var(--ui-text-min-opacity)))",
          transition: "background 120ms",
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "rgb(var(--ui-ink-rgb) / 0.18)"; }}
        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "rgb(var(--ui-ink-rgb) / 0.1)"; }}
      >
        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>

      {/* App icon */}
      <div style={{
        width: "44px", height: "44px", borderRadius: "10px",
        background: "rgb(var(--ui-ink-rgb) / 0.06)",
        border: "1px solid rgb(var(--ui-ink-rgb) / 0.08)",
        display: "flex", alignItems: "center", justifyContent: "center",
        flexShrink: 0, overflow: "hidden",
      }}>
        <Image src="/HG.svg" alt="HeliosGen" width={32} height={32} />
      </div>

      {/* Text */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "2px", paddingRight: "12px" }}>
        <span style={{
          fontSize: "13px", fontWeight: 600, color: "var(--ui-tone-ffffff)",
          letterSpacing: "-0.01em", lineHeight: 1.3,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {toast.title}
        </span>
        <span style={{
          fontSize: "12px", color: "rgb(var(--ui-ink-rgb) / max(0.45, var(--ui-text-min-opacity)))", lineHeight: 1.4,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {toast.preview}
        </span>
      </div>
    </div>
  );
}

// Simple toast — errors, info, generic success
function SimpleToastItem({ toast, onDismiss, onClick }: { toast: Toast; onDismiss: (e: React.MouseEvent) => void; onClick: () => void }) {
  const c = COLORS[toast.type];
  return (
    <div
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: "10px",
        padding: "12px 14px",
        borderRadius: "10px",
        background: c.bg,
        border: `1px solid ${c.border}`,
        boxShadow: "0 8px 24px rgb(var(--ui-shadow-rgb)/calc(0.4*var(--ui-shadow-opacity)))",
        backdropFilter: "blur(8px)",
        maxWidth: "360px",
        animation: "toastIn 200ms cubic-bezier(0.22,1,0.36,1) both",
        cursor: toast.href ? "pointer" : "default",
      }}
    >
      <svg
        width="16" height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke={c.icon}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ flexShrink: 0, marginTop: "1px" }}
      >
        <path d={ICONS[toast.type]} />
      </svg>
      <span style={{ fontSize: "13px", color: "rgb(var(--ui-ink-rgb) / 0.85)", lineHeight: 1.45, flex: 1 }}>
        {toast.message}
      </span>
      <DismissButton onDismiss={onDismiss} />
    </div>
  );
}

function ToastItem({ toast }: { toast: Toast }) {
  const removeToast = useWorkflowStore((s) => s.removeToast);
  const router = useRouter();
  const isRich = !!(toast.title && toast.preview);
  const dismissDuration = isRich ? null : toast.href ? 8000 : 4000;

  useEffect(() => {
    if (dismissDuration === null) return;
    const t = setTimeout(() => removeToast(toast.id), dismissDuration);
    return () => clearTimeout(t);
  }, [toast.id, removeToast, dismissDuration]);

  function handleClick() {
    if (toast.href) {
      removeToast(toast.id);
      router.push(toast.href);
    }
  }

  function handleDismiss(e: React.MouseEvent) {
    e.stopPropagation();
    removeToast(toast.id);
  }

  if (toast.title && toast.preview) {
    return <RichToastItem toast={toast} onDismiss={handleDismiss} onClick={handleClick} />;
  }

  return <SimpleToastItem toast={toast} onDismiss={handleDismiss} onClick={handleClick} />;
}

export default function Toaster() {
  const toasts = useWorkflowStore((s) => s.toasts);

  return (
    <>
      <style>{`
        @keyframes toastIn {
          from { opacity: 0; transform: translateY(-10px) scale(0.96); }
          to   { opacity: 1; transform: translateY(0)     scale(1); }
        }
      `}</style>
      <div
        style={{
          position: "fixed",
          top: "24px",
          right: "24px",
          zIndex: 99999,
          display: "flex",
          flexDirection: "column",
          gap: "8px",
          pointerEvents: toasts.length ? "auto" : "none",
        }}
      >
        {toasts.map((t) => <ToastItem key={t.id} toast={t} />)}
      </div>
    </>
  );
}
