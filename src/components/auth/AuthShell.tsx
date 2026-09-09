import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/components/layout/Logo";

export function AuthShell({ title, subtitle, children, aside }: { title: string; subtitle: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="min-h-dvh paper-grid">
      <div className="max-w-md mx-auto px-4 pt-8 pb-12">
        <Link href="/" className="inline-block mb-8">
          <Logo size={32} />
        </Link>
        <h1 className="text-3xl font-bold leading-tight">{title}</h1>
        <p className="text-muted mt-1 mb-6">{subtitle}</p>
        <div className="card p-5">{children}</div>
        {aside}
      </div>
    </div>
  );
}
