"use client";
import { LogOut } from "lucide-react";
import { useTransition } from "react";
import { signOutAction } from "@/server/actions/auth";
import { Button } from "@/components/ui/Button";
import { forgetPrivatePages } from "@/components/pwa/RegisterServiceWorker";

export function SignOutButton() {
  const [pending, start] = useTransition();
  return (
    <Button variant="ghost" size="sm" loading={pending} onClick={() => start(async () => { await forgetPrivatePages(); await signOutAction(); })}>
      <LogOut size={16} />
      Sign out
    </Button>
  );
}
