import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Check } from "lucide-react";
import { paymentsMode } from "@/lib/config";
import { requireViewer } from "@/lib/auth/server";
import { getRepository } from "@/lib/data";
import { PLUS_LIST_CAP, PLUS_MONTHLY_PRICE } from "@/lib/data/payments";
import { PageHeader } from "@/components/ui/PageHeader";
import { PlusButton } from "@/components/payments/PlusButtons";
import { LocalDate } from "@/components/time/LocalDate";

export const metadata: Metadata = { title: "Plus" };
export const dynamic = "force-dynamic";

const PERKS = [
  `Up to ${PLUS_LIST_CAP.toLocaleString("en-US")} lists (instead of 100)`,
  "30 AI day plans a day (instead of 10)",
  "A supporter badge on your profile",
  "No sponsored cards",
];

/** Plus: convenience and support. It never buys visibility, ranking or reach. */
export default async function PlusPage({ searchParams }: PageProps<"/plus">) {
  const mode = paymentsMode();
  if (!mode) notFound();
  const viewer = await requireViewer("/plus");
  const sp = await searchParams;
  const entitlement = await (await getRepository()).payments.entitlement(viewer.id);
  const active = !!entitlement?.active;
  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 pt-4 md:pt-8 pb-nav md:pb-10">
      <PageHeader eyebrow="Support FindMaxxing" title="FindMaxxing Plus" subtitle={`${PLUS_MONTHLY_PRICE} a month. Cancel any time.`} />
      {sp.status === "success" ? <p role="status" className="card p-3 mb-4 text-sm font-semibold">Thanks for supporting FindMaxxing. Your perks are on{mode === "stripe" ? " as soon as Stripe confirms" : ""}.</p> : null}
      <div className="card p-5">
        <ul className="flex flex-col gap-2">
          {PERKS.map((p) => (
            <li key={p} className="flex gap-2 text-[15px]"><Check size={18} className="text-pulse shrink-0 mt-0.5" />{p}</li>
          ))}
        </ul>
        <p className="text-sm text-muted mt-4">
          Plus never changes what you or anyone else sees in discovery: no boosted places, no paid ranking, no extra reach.
        </p>
        <div className="mt-4 flex items-center gap-3">
          <PlusButton active={active} />
          {active && entitlement?.currentPeriodEnd ? <span className="text-sm text-muted">Renews or ends <LocalDate value={entitlement.currentPeriodEnd} format={{ month: "short", day: "numeric" }} /></span> : null}
        </div>
        {mode === "demo" ? <p className="text-xs text-muted mt-3">Demo mode: the checkout is simulated and no money moves.</p> : null}
      </div>
    </div>
  );
}
