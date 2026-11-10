import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Doto } from "next/font/google";
import "./globals.css";
import "./theme.css";
import ThemeProvider from "@/components/ThemeProvider";
import { AppSidebar } from "@/components/AppSidebar";
import GlobalModals from "@/components/GlobalModals";
import ExternalTaskWorkspace from "@/components/ExternalTaskWorkspace";
import ProviderBanner from "@/components/ProviderBanner";
import UpdateBanner from "@/components/UpdateBanner";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cookies } from "next/headers";
import { DragDropGuard } from "@/components/DragDropGuard";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const doto = Doto({
  variable: "--font-doto",
  subsets: ["latin"],
  weight: ["900"],
});

export const metadata: Metadata = {
  title: "HeliosGen",
  description: "Build AI image & video generation workflows visually",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  const sidebarOpen = cookieStore.get("sidebar_state")?.value !== "false";

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${doto.variable} antialiased dark`}
      style={{ height: "100%" }}
      suppressHydrationWarning
    >
      <body className="bg-background text-foreground h-full overflow-hidden">
        <ThemeProvider>
        <TooltipProvider>
          <SidebarProvider defaultOpen={sidebarOpen} className="h-full">
            <AppSidebar />
            <ExternalTaskWorkspace>
            <SidebarInset style={{ backgroundColor: "transparent" }} className="flex flex-col min-h-0 min-w-0 border-l border-r border-t border-foreground/[0.08] mx-2 mt-2 rounded-tl-xl rounded-tr-xl">
              <ProviderBanner />
              <UpdateBanner />
              <div className="md:hidden flex items-center h-10 px-3 border-b border-foreground/[0.08] shrink-0">
                <SidebarTrigger className="text-[var(--ui-text-50)] hover:text-foreground hover:bg-foreground/[0.05] transition-colors rounded-lg p-1.5 [&_svg]:size-4" />
              </div>
              <DragDropGuard />
        {children}
            </SidebarInset>
            </ExternalTaskWorkspace>
          </SidebarProvider>
        </TooltipProvider>
        <GlobalModals />
        </ThemeProvider>
      </body>
    </html>
  );
}
