import { Suspense, useMemo } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource/doto/900.css";
import "../app/globals.css";
import "../app/theme.css";
import "./styles.css";
import ThemeProvider from "@/components/ThemeProvider";
import { AppSidebar } from "@/components/AppSidebar";
import GlobalModals from "@/components/GlobalModals";
import ExternalTaskWorkspace from "@/components/ExternalTaskWorkspace";
import ProviderBanner from "@/components/ProviderBanner";
import UpdateBanner from "@/components/UpdateBanner";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DragDropGuard } from "@/components/DragDropGuard";
import GalleryPage from "@/app/gallery/page";
import ChatPage from "@/app/chat/page";
import AssetsPage from "@/app/assets/page";
import WorkflowDashboardPage from "@/app/workflow/page";
import WorkflowPage from "@/app/workflow/[id]/page";
import { redirect, usePathname } from "./navigation";

if (window.location.pathname === "/") redirect("/gallery?tab=images");

function Page() {
  const pathname = usePathname();
  const id = pathname.startsWith("/workflow/") ? decodeURIComponent(pathname.slice("/workflow/".length)) : "";
  const params = useMemo(() => Promise.resolve({ id }), [id]);
  if (pathname === "/chat") return <ChatPage />;
  if (pathname === "/assets") return <AssetsPage />;
  if (pathname === "/workflow") return <WorkflowDashboardPage />;
  if (id) return <Suspense fallback={null}><WorkflowPage key={id} params={params} /></Suspense>;
  return <GalleryPage />;
}

function App() {
  const sidebarOpen = !document.cookie.split(";").some((cookie) => cookie.trim() === "sidebar_state=false");
  return <ThemeProvider><TooltipProvider><SidebarProvider defaultOpen={sidebarOpen} className="h-full">
    <AppSidebar />
    <ExternalTaskWorkspace>
    <SidebarInset style={{ backgroundColor: "transparent" }} className="flex flex-col min-h-0 min-w-0 border-l border-r border-t border-foreground/[0.08] mx-2 mt-2 rounded-tl-xl rounded-tr-xl">
      <ProviderBanner /><UpdateBanner />
      <div className="md:hidden flex items-center h-10 px-3 border-b border-foreground/[0.08] shrink-0"><SidebarTrigger className="text-[var(--ui-text-50)] hover:text-foreground hover:bg-foreground/[0.05] transition-colors rounded-lg p-1.5 [&_svg]:size-4" /></div>
      <DragDropGuard /><Page />
    </SidebarInset>
    </ExternalTaskWorkspace>
  </SidebarProvider></TooltipProvider><GlobalModals /></ThemeProvider>;
}

createRoot(document.getElementById("root")!).render(<App />);
