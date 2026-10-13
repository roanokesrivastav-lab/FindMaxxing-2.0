"use client";
import { useEffect, useRef } from "react";
import { markNotificationsReadAction } from "@/server/actions/notifications";

/** Opening the page reads what it shows (the list keeps its unread styling until the next visit). */
export function MarkReadOnView({ ids }: { ids: string[] }) {
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !ids.length) return;
    done.current = true;
    void markNotificationsReadAction(ids);
  }, [ids]);
  return null;
}
