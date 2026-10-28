import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Figtree } from "next/font/google";
import "./globals.css";
import { AppShell } from "@/components/layout/AppShell";
import { RegisterServiceWorker } from "@/components/pwa/RegisterServiceWorker";
import { getViewer } from "@/lib/auth/server";
import { ToastProvider } from "@/components/ui/Toast";
import { featureEnabled, getDataMode, getSiteUrl } from "@/lib/config";
import { getRepository } from "@/lib/data";
import { ViewerTimeProvider } from "@/components/time/ViewerTime";
import { getViewerTime } from "@/lib/time/server";

const figtree = Figtree({
  variable: "--font-figtree",
  subsets: ["latin"],
  display: "swap",
});

const bricolage = Bricolage_Grotesque({
  variable: "--font-bricolage",
  subsets: ["latin"],
  display: "swap",
  weight: ["500", "600", "700", "800"],
});

const DESCRIPTION =
  "Local knowledge, mapped. Discover the places locals actually use, save them, add your own, and meet people doing what you love.";

export const metadata: Metadata = {
  // Lets page-level openGraph/twitter images and urls be relative.
  metadataBase: new URL(getSiteUrl()),
  title: {
    default: "FindMaxxing",
    template: "%s · FindMaxxing",
  },
  description: DESCRIPTION,
  applicationName: "FindMaxxing",
  openGraph: { type: "website", siteName: "FindMaxxing", title: "FindMaxxing", description: DESCRIPTION },
  twitter: { card: "summary", title: "FindMaxxing", description: DESCRIPTION },
  appleWebApp: { capable: true, title: "FindMaxxing", statusBarStyle: "default" },
  icons: { apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  themeColor: "#f6f4ee",
  width: "device-width",
  initialScale: 1,
  // No maximumScale: people must be able to pinch-zoom text (WCAG 1.4.4).
  viewportFit: "cover",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const [viewer, time] = await Promise.all([getViewer(), getViewerTime()]);
  // Flag-gated rail entries. A failed unread count never breaks the page.
  const messaging = !!viewer && featureEnabled("messaging");
  const notificationsOn = !!viewer && featureEnabled("notifications");
  const [unread, notifications] = await Promise.all([
    messaging ? getRepository().then((r) => r.messaging.unreadTotal(viewer.id)).catch(() => 0) : null,
    notificationsOn ? getRepository().then((r) => r.notifications.unreadCount(viewer.id)).catch(() => 0) : null,
  ]);
  const extras = { plan: !!viewer && featureEnabled("tripPlanning"), unread, notifications };
  return (
    <html lang="en" className={`${figtree.variable} ${bricolage.variable} h-full`}>
      <body className="min-h-full flex flex-col">
        <ViewerTimeProvider initial={time}>
          <ToastProvider>
            <AppShell viewer={viewer} dataMode={getDataMode()} extras={extras}>
              {children}
            </AppShell>
            {featureEnabled("pwa") ? <RegisterServiceWorker /> : null}
          </ToastProvider>
        </ViewerTimeProvider>
      </body>
    </html>
  );
}
