import "server-only";
import { notFound } from "next/navigation";
import { requireViewer } from "@/lib/auth/server";
import { getRepository } from "@/lib/data";
import { featureEnabled } from "@/lib/config";

/** The dashboard is for admins, with the admin flag on; everyone else gets a 404. */
export async function requireAdmin(path: string) {
  const viewer = await requireViewer(path);
  const repo = await getRepository();
  if (!featureEnabled("admin") || !(await repo.admin.isAdmin(viewer.id))) notFound();
  return { viewer, repo };
}

export const ADMIN_DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
