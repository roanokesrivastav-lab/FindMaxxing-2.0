import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { devUiAvailable } from "@/lib/devUi";
import { Row } from "@/components/ui/Row";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { StatusLabel, type StatusTone } from "@/components/ui/StatusLabel";
import { Surface } from "@/components/ui/Surface";
import { PlaceGlyph } from "@/components/ui/PlaceGlyph";

export const metadata: Metadata = { title: "UI primitives", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * Roadmap 1.1: every design primitive with long text, no photo and 200% text.
 * Demo only (see devUiAvailable): 404 unless demo mode and the pilotFoundation flag.
 */
// A generated stand-in photo (no external image request; the app ships no stock photos).
const PHOTO =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffb400"/><stop offset="1" stop-color="#ff4d2e"/></linearGradient></defs><rect width="120" height="120" fill="url(#g)"/><circle cx="84" cy="34" r="14" fill="#fff4f0"/><path d="M0 96 L40 58 L70 86 L92 66 L120 92 V120 H0 Z" fill="#17181d" opacity=".55"/></svg>`,
  );
const LONG =
  "Kowalczyk-Abernathy Neighbourhood Cooperative Coffee Roasters and Late-Night Reading Room (formerly the Old Fire Station)";
const TONES: [StatusTone, string][] = [
  ["positive", "Going"],
  ["pending", "Waitlisted"],
  ["warning", "2 more needed"],
  ["negative", "Cancelled"],
  ["neutral", "Interested"],
];

export default async function DevUiPage({ searchParams }: { searchParams: Promise<{ text?: string }> }) {
  if (!devUiAvailable()) notFound();
  const big = (await searchParams).text === "200";
  return (
    <div className="mx-auto max-w-xl px-edge pb-nav pt-section">
      {/* Simulates a 200% browser text setting: every type role is rem-based, so it all scales. */}
      {big ? <style>{"html{font-size:200%!important}"}</style> : null}
      <p className="type-body text-muted">Demo only · roadmap 1.1</p>
      <h1 className="type-page-title text-ink">UI primitives</h1>
      <p className="type-body text-ink-2 mt-item">
        {big ? <Link href="/dev/ui" className="underline">Back to normal text</Link> : <Link href="/dev/ui?text=200" className="underline">View at 200% text</Link>}
      </p>

      <section aria-labelledby="type">
        <SectionHeader id="type" title="Type roles" />
        <p className="type-page-title">Page title · 28–32px</p>
        <p className="type-item-title mt-item">Item title · 16–18px</p>
        <p className="type-body mt-item">Body and support · 14–16px. {LONG}</p>
      </section>

      <section aria-labelledby="surfaces" className="treatment-utility">
        <SectionHeader id="surfaces" title="Surfaces" action="raised · flat · inset" />
        <Surface variant="raised" className="p-row">
          <p className="type-item-title">Raised</p>
          <p className="type-body text-ink-2">Floats over the map, or the selected item. The only shadow.</p>
        </Surface>
        <div className="mt-row">
          <Surface variant="flat" className="py-row"><p className="type-item-title">Flat row</p><p className="type-body text-ink-2">A comparable item. No box; a hairline between rows.</p></Surface>
          <Surface variant="flat" className="py-row"><p className="type-item-title">Flat row</p><p className="type-body text-ink-2">{LONG}</p></Surface>
        </div>
        <Surface variant="inset" className="p-row mt-row">
          <p className="type-body font-semibold">Inset · local tip</p>
          <p className="type-body text-ink-2">Ask for the corner table by the window; it&apos;s the quiet one.</p>
        </Surface>
      </section>

      <section aria-labelledby="rows" className="treatment-utility">
        <SectionHeader id="rows" title="Rows" action={<Link href="/dev/ui#rows">See all</Link>} />
        <ul className="list-none p-0 m-0">
          <Row as="li" media={{ photo: { src: PHOTO, alt: "Stand-in photo of a sunset over hills" } }} title="With a photo" meta="Coffee · Short North · 0.4 mi" trailing="4.6 (31)" />
          <Row as="li" media={{ categorySlug: "coffee-study" }} title="No photo: PlaceGlyph" meta="Coffee · Short North" trailing="New" />
          <Row as="li" media={{ categorySlug: "pickup-sports" }} title={LONG} meta={`${LONG}. Meta lines wrap rather than truncate.`} trailing={<StatusLabel tone="positive">Going</StatusLabel>} />
          <Row as="li" title="No media at all" meta="Rows don't need media." href="/dev/ui#rows" />
        </ul>
      </section>

      <section aria-labelledby="status">
        <SectionHeader id="status" title="Status labels" action="text + shape, never colour alone" />
        <ul className="list-none p-0 m-0 flex flex-wrap gap-x-row gap-y-item">
          {TONES.map(([tone, text]) => (
            <li key={tone}><StatusLabel tone={tone}>{text}</StatusLabel></li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="glyphs">
        <SectionHeader id="glyphs" title="PlaceGlyph" action="no-photo fallback" />
        <div className="flex flex-wrap gap-item">
          {["coffee-study", "food", "outdoors", "nightlife", "pickup-sports", "unknown-category"].map((slug) => (
            <PlaceGlyph key={slug} categorySlug={slug} label={`${slug} category`} />
          ))}
        </div>
      </section>
    </div>
  );
}
