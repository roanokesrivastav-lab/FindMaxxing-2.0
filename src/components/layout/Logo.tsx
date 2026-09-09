import { cn } from "@/lib/utils/cn";

export function Logo({ className, size = 28 }: { className?: string; size?: number }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-display font-extrabold tracking-tight", className)}>
      <LogoMark size={size} />
      <span style={{ fontSize: size * 0.72 }}>
        Find<span className="text-flare">Maxxing</span>
      </span>
    </span>
  );
}

export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <rect width="32" height="32" rx="9" fill="#17181d" />
      <path d="M16 6c-4.4 0-8 3.5-8 7.9C8 19.6 16 26 16 26s8-6.4 8-12.1C24 9.5 20.4 6 16 6Z" fill="#ff4d2e" />
      <circle cx="16" cy="14" r="3.2" fill="#f6f4ee" />
    </svg>
  );
}
