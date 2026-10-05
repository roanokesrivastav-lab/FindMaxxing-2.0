import { cn } from "@/lib/utils/cn";
import { initials } from "@/lib/utils/format";

const PALETTE = ["#ff4d2e", "#6b4cff", "#1f8a5b", "#0e8f8a", "#e0741f", "#c0399b", "#3b6fd6", "#e8a600"];

function colorFor(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function Avatar({
  name,
  src,
  size = 40,
  className,
}: {
  name: string;
  src?: string | null;
  size?: number;
  className?: string;
}) {
  const style = { width: size, height: size, fontSize: Math.max(11, size * 0.38) };
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={name} style={style} loading="lazy" decoding="async" className={cn("rounded-full object-cover shrink-0 bg-surface-2", className)} />;
  }
  return (
    <span
      style={{ ...style, background: colorFor(name) }}
      className={cn("rounded-full inline-flex items-center justify-center font-display font-bold text-white shrink-0", className)}
      aria-label={name}
    >
      {initials(name)}
    </span>
  );
}

export function AvatarStack({ people, max = 4, size = 28 }: { people: { id: string; displayName: string; avatarUrl: string | null }[]; max?: number; size?: number }) {
  const shown = people.slice(0, max);
  const rest = people.length - shown.length;
  return (
    <span className="inline-flex items-center">
      {shown.map((p, i) => (
        <span key={p.id} className="rounded-full ring-2 ring-surface" style={{ marginLeft: i === 0 ? 0 : -size * 0.3 }}>
          <Avatar name={p.displayName} src={p.avatarUrl} size={size} />
        </span>
      ))}
      {rest > 0 ? (
        <span
          className="rounded-full ring-2 ring-surface bg-surface-2 text-ink-2 font-semibold inline-flex items-center justify-center"
          style={{ width: size, height: size, marginLeft: -size * 0.3, fontSize: size * 0.4 }}
        >
          +{rest}
        </span>
      ) : null}
    </span>
  );
}
