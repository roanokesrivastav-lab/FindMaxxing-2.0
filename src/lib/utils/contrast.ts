/**
 * WCAG contrast helpers. Category and avatar colours are chosen for the map,
 * where they are fills; as text (or behind white text) many are too light.
 * readableInk darkens a colour just enough to pass AA for normal text.
 */
function channel(hex: string, i: number): number {
  return parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
}

export function luminance(hex: string): number {
  const [r, g, b] = [0, 1, 2].map((i) => {
    const v = channel(hex, i) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const cache = new Map<string, string>();

/**
 * The colour, darkened until it has at least 5.6:1 against white. That passes
 * AA (4.5:1) as text on white or on the colour's own light tint (which is a
 * little darker than white), and for white text on it. Colours that already
 * pass come back unchanged.
 */
export function readableInk(hex: string): string {
  const key = hex.toLowerCase();
  const hit = cache.get(key);
  if (hit) return hit;
  let out = key;
  for (let f = 1; f > 0.2 && contrastRatio(out, "#ffffff") < 5.6; f -= 0.02) {
    out = `#${[0, 1, 2].map((i) => Math.round(channel(key, i) * f).toString(16).padStart(2, "0")).join("")}`;
  }
  cache.set(key, out);
  return out;
}
