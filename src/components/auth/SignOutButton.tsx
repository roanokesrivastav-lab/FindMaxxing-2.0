"use client";
import { LogOut } from "lucide-react";
import { useTransition } from "react";
import { signOutAction } from "@/server/actions/auth";
import { Button } from "@/components/ui/Button";

export function SignOutButton() {
  const [pending, start] = useTransition();
  return (
    <Button variant="ghost" size="sm" loading={pending} onClick={() => start(() => signOutAction())}>
      <LogOut size={16} />
      Sign out
    </Button>
  );
}
