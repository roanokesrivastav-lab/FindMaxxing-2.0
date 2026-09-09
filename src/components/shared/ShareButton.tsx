"use client";
import { Check, Share2 } from "lucide-react";
import { useState, useTransition } from "react";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";

/**
 * Shares the current page. Uses the native share sheet where the browser has
 * one (most phones), otherwise copies the link and confirms with a toast.
 */
export function ShareButton({
  title,
  text,
  variant = "icon",
  className,
}: {
  title: string;
  text?: string;
  variant?: "icon" | "pill";
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [, start] = useTransition();
  const { toast } = useToast();

  const share = () => {
    const url = window.location.href;

    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      navigator.share({ title, text, url }).catch(() => {
        // A cancelled share sheet is a normal outcome, not an error.
      });
      return;
    }

    start(async () => {
      try {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        toast("Link copied", "success");
        setTimeout(() => setCopied(false), 2000);
      } catch {
        toast("Couldn't copy the link. Copy it from the address bar.", "error");
      }
    });
  };

  if (variant === "pill") {
    return (
      <button
        type="button"
        onClick={share}
        className={cn("chip", className)}
        aria-label={`Share ${title}`}
      >
        {copied ? <Check size={15} /> : <Share2 size={15} />}
        {copied ? "Copied" : "Share"}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={share}
      aria-label={`Share ${title}`}
      className={cn(
        "h-10 w-10 inline-flex items-center justify-center rounded-full border border-line bg-surface/90 backdrop-blur text-ink transition-colors hover:bg-surface active:scale-95",
        className,
      )}
    >
      {copied ? <Check size={18} /> : <Share2 size={18} />}
    </button>
  );
}
