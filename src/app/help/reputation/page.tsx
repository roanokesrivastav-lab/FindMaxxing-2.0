import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/PageHeader";
import { BackButton } from "@/components/ui/BackButton";

export const metadata: Metadata = { title: "How levels work" };

export default function ReputationHelpPage() {
  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 pt-4 md:pt-8 pb-nav md:pb-10">
      <div className="mb-4"><BackButton fallback="/profile" /></div>
      <PageHeader eyebrow="Help" title="How levels work" subtitle="Levels show who reliably adds good local knowledge. There is no score to chase, and nothing to buy." />
      <section className="card p-5 flex flex-col gap-4 text-[15px] leading-relaxed">
        <div>
          <h2 className="font-bold">The three levels</h2>
          <ul className="mt-2 list-disc pl-5 flex flex-col gap-1">
            <li><b>New</b>: everyone starts here.</li>
            <li><b>Contributor</b>: you have added places and events other people use, and your account is at least a week old.</li>
            <li><b>Trusted local</b>: a lot of that, over at least a month, and your local status is in good standing. Trusted locals can see places shared only with them.</li>
          </ul>
        </div>
        <div>
          <h2 className="font-bold">What counts</h2>
          <p className="mt-1">Things other people do with what you add, because they are hard to fake on your own:</p>
          <ul className="mt-2 list-disc pl-5 flex flex-col gap-1">
            <li>other people saving and rating your places</li>
            <li>people actually joining your events</li>
            <li>your places staying up, not removed, for at least two weeks</li>
            <li>reports you file that moderators act on</li>
          </ul>
          <p className="mt-2">Content moderators remove counts heavily against you, and so do reports they dismiss. Saving your own places, rating them, or joining your own events counts for nothing. New accounts grow into their level over their first month.</p>
        </div>
        <div>
          <h2 className="font-bold">How it is used</h2>
          <p className="mt-1">Levels appear on profiles, decide who can see trusted-locals places, and nudge ranking when places are otherwise tied. Ratings and saves always come first. Moderators can reset a level when it was gamed; that is recorded with a reason.</p>
          <p className="mt-2 text-sm text-muted">Levels update about once an hour.</p>
        </div>
      </section>
    </div>
  );
}
