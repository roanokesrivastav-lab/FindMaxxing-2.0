import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Figtree } from "next/font/google";
import "./globals.css";
import { AppShell } from "@/components/layout/AppShell";
import { getViewer } from "@/lib/auth/server";
import { ToastProvider } from "@/components/ui/Toast";
import { getDataMode } from "@/lib/config";

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

export const metadata: Metadata = {
  title: {
    default: "FindMaxxing",
    template: "%s · FindMaxxing",
  },
  description:
    "Local knowledge, mapped. Discover the places locals actually use, save them, add your own, and meet people doing what you love.",
  applicationName: "FindMaxxing",
  appleWebApp: { capable: true, title: "FindMaxxing", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  themeColor: "#f6f4ee",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const viewer = await getViewer();
  return (
    <html lang="en" className={`${figtree.variable} ${bricolage.variable} h-full`}>
      <body className="min-h-full flex flex-col">
        <ToastProvider>
          <AppShell viewer={viewer} dataMode={getDataMode()}>
            {children}
          </AppShell>
        </ToastProvider>
      </body>
    </html>
  );
}
