"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { managePlusAction, subscribePlusAction } from "@/server/actions/payments";

export function PlusButton({ active }: { active: boolean }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  return (
    <Button type="button" variant={active ? "secondary" : "primary"} loading={pending} onClick={() => start(async () => {
      const res = active ? await managePlusAction() : await subscribePlusAction();
      if (!res.ok) toast(res.error, "error");
      else if (res.data.url.startsWith("/")) router.push(res.data.url);
      else window.location.assign(res.data.url);
    })}>
      {active ? "Manage your plan" : "Get Plus"}
    </Button>
  );
}
