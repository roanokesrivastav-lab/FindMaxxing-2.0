"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { removePushDeviceAction, savePushDeviceAction } from "@/server/actions/notifications";

/** VAPID public keys are URL-safe base64; the Push API wants bytes. */
function keyBytes(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function detect(): Promise<"unsupported" | "denied" | "off" | "on"> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  try {
    const reg = await navigator.serviceWorker.getRegistration("/");
    return (await reg?.pushManager.getSubscription()) ? "on" : "off";
  } catch {
    return "off";
  }
}

/** Opt this device in or out of push. Each device opts in separately. */
export function PushToggle({ publicKey }: { publicKey: string }) {
  const [state, setState] = useState<"unsupported" | "denied" | "off" | "on" | "loading">("loading");
  const { toast } = useToast();

  useEffect(() => {
    let cancelled = false;
    detect().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const enable = async () => {
    setState("loading");
    try {
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      if ((await Notification.requestPermission()) !== "granted") {
        setState("denied");
        return;
      }
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
      const res = await savePushDeviceAction(sub.toJSON());
      if (!res.ok) {
        await sub.unsubscribe();
        toast(res.error, "error");
        setState("off");
        return;
      }
      setState("on");
      toast("Push notifications are on for this device", "success");
    } catch {
      toast("This browser couldn't turn on push notifications", "error");
      setState("off");
    }
  };

  const disable = async () => {
    setState("loading");
    const reg = await navigator.serviceWorker.getRegistration("/");
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await removePushDeviceAction(sub.endpoint);
      await sub.unsubscribe();
    }
    setState("off");
  };

  if (state === "unsupported") return <p className="text-sm text-muted">This browser doesn&apos;t support push notifications. On iPhone, add FindMaxxing to your Home Screen first.</p>;
  if (state === "denied") return <p className="text-sm text-muted">Notifications are blocked for this site in your browser settings.</p>;
  return state === "on" ? (
    <Button type="button" variant="secondary" size="sm" onClick={disable}>Turn off push on this device</Button>
  ) : (
    <Button type="button" variant="ink" size="sm" onClick={enable} loading={state === "loading"}>Turn on push on this device</Button>
  );
}
