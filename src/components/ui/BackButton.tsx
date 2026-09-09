"use client";
import { ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";

export function BackButton({ fallback = "/", className }: { fallback?: string; className?: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => (window.history.length > 1 ? router.back() : router.push(fallback))}
      className={className ?? "h-10 w-10 inline-flex items-center justify-center rounded-full bg-surface/90 backdrop-blur border border-line shadow-card"}
      aria-label="Back"
    >
      <ArrowLeft size={18} />
    </button>
  );
}
