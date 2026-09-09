/**
 * Categories and interests are the shared vocabulary of the app.
 * They are mirrored in the `categories` and `interests` tables; the DB seed
 * is generated from this file so there is one source of truth.
 */

export type CategoryScope = "place" | "event" | "both";

export interface Category {
  slug: string;
  label: string;
  emoji: string;
  /** Hex color used for pins and accents. */
  color: string;
  scope: CategoryScope;
  hint: string;
  /** Extra search terms so discovery-style queries ("soccer", "wifi") match. */
  keywords: string[];
}

export const CATEGORIES: Category[] = [
  { slug: "pickup-sports", label: "Pickup sports", emoji: "⚽", color: "#1f8a5b", scope: "both", hint: "Fields, courts and rinks where games actually happen", keywords: ["soccer", "football", "basketball", "volleyball", "pickleball", "futsal", "tennis", "hoops", "court", "field", "pitch", "game"] },
  { slug: "sports-bar", label: "Sports bar", emoji: "📺", color: "#ff4d2e", scope: "place", hint: "Reliable spots to watch the game", keywords: ["game", "watch", "tv", "screens", "football", "buckeyes", "beer", "wings"] },
  { slug: "watch-party", label: "Watch party", emoji: "🏈", color: "#ff4d2e", scope: "event", hint: "Game day, together", keywords: ["game", "football", "buckeyes", "tv", "screens"] },
  { slug: "outdoors", label: "Outdoors", emoji: "🌲", color: "#2f7d4f", scope: "both", hint: "Trails, parks, rivers, sunsets", keywords: ["hike", "trail", "park", "river", "kayak", "disc golf", "skate", "sunset", "nature", "walk"] },
  { slug: "fitness", label: "Fitness", emoji: "🧗", color: "#0e8f8a", scope: "both", hint: "Gyms, climbing, run clubs, yoga", keywords: ["gym", "climbing", "bouldering", "run club", "yoga", "workout", "running"] },
  { slug: "food", label: "Food", emoji: "🌮", color: "#e0741f", scope: "both", hint: "Cheap, good, and not on every list already", keywords: ["restaurant", "eat", "cheap", "tacos", "dumplings", "late night", "dinner", "lunch"] },
  { slug: "coffee-study", label: "Coffee & study", emoji: "☕", color: "#8b5a2b", scope: "both", hint: "Quiet corners, good wifi, outlets", keywords: ["cafe", "wifi", "laptop", "quiet", "library", "study", "outlets", "work"] },
  { slug: "nightlife", label: "Nightlife", emoji: "🌙", color: "#6b4cff", scope: "both", hint: "Bars, late nights, dance floors", keywords: ["bar", "drinks", "late", "dance", "bowling", "rooftop", "cocktails"] },
  { slug: "music", label: "Music", emoji: "🎸", color: "#c0399b", scope: "both", hint: "Live shows, jams, open mics", keywords: ["concert", "show", "live", "band", "open mic", "venue", "dj"] },
  { slug: "arts", label: "Arts", emoji: "🎨", color: "#d1436b", scope: "both", hint: "Galleries, studios, makers", keywords: ["gallery", "studio", "print", "mural", "craft", "workshop", "creative"] },
  { slug: "gaming-hobby", label: "Gaming & hobbies", emoji: "🎲", color: "#3b6fd6", scope: "both", hint: "Board games, cards, niche hobbies", keywords: ["board games", "chess", "cards", "video games", "dnd", "hobby", "tabletop"] },
  { slug: "date-spot", label: "Date spot", emoji: "💛", color: "#e8a600", scope: "place", hint: "Low-key, memorable, affordable", keywords: ["date", "romantic", "cheap date", "wine", "sunset", "couples"] },
  { slug: "community", label: "Community", emoji: "🤝", color: "#4c8ac9", scope: "both", hint: "Markets, meetups, volunteering", keywords: ["market", "meetup", "volunteer", "newcomers", "neighborhood", "festival"] },
  { slug: "college", label: "College life", emoji: "🎓", color: "#b13a3a", scope: "both", hint: "Campus-adjacent staples", keywords: ["campus", "osu", "students", "university", "dorm"] },
  { slug: "other", label: "Other", emoji: "📍", color: "#7b7c85", scope: "both", hint: "Everything else worth knowing", keywords: [] },
];

export const CATEGORY_MAP: Record<string, Category> = Object.fromEntries(
  CATEGORIES.map((c) => [c.slug, c]),
);

export const PLACE_CATEGORIES = CATEGORIES.filter((c) => c.scope !== "event");
export const EVENT_CATEGORIES = CATEGORIES.filter((c) => c.scope !== "place");

export function getCategory(slug: string): Category {
  return CATEGORY_MAP[slug] ?? CATEGORY_MAP.other;
}

/** All searchable words for a category + tag set: labels, hints and keywords. */
export function searchTerms(categorySlug: string, tags: string[]): string[] {
  const c = getCategory(categorySlug);
  const out = [c.label, c.hint, ...c.keywords];
  for (const t of tags) {
    const i = getInterest(t);
    out.push(i.label, ...(i.keywords ?? []));
  }
  return out;
}

export interface Interest {
  slug: string;
  label: string;
  emoji: string;
  keywords?: string[];
}

export const INTERESTS: Interest[] = [
  { slug: "sports", label: "Sports", emoji: "🏀", keywords: ["soccer", "basketball", "football", "buckeyes"] },
  { slug: "pickup-sports", label: "Pickup games", emoji: "⚽", keywords: ["soccer", "basketball", "volleyball", "pickleball", "football"] },
  { slug: "fitness", label: "Fitness", emoji: "💪" },
  { slug: "hiking", label: "Hiking", emoji: "🥾", keywords: ["trail", "hike", "walk"] },
  { slug: "outdoors", label: "Outdoors", emoji: "🏕️" },
  { slug: "food", label: "Food", emoji: "🍜" },
  { slug: "coffee", label: "Coffee", emoji: "☕", keywords: ["cafe", "espresso"] },
  { slug: "studying", label: "Studying", emoji: "📚", keywords: ["study", "wifi", "quiet", "library"] },
  { slug: "nightlife", label: "Nightlife", emoji: "🪩" },
  { slug: "music", label: "Music", emoji: "🎶" },
  { slug: "art", label: "Art", emoji: "🖌️" },
  { slug: "gaming", label: "Gaming", emoji: "🎮" },
  { slug: "board-games", label: "Board games", emoji: "🎲", keywords: ["chess", "tabletop", "cards"] },
  { slug: "climbing", label: "Climbing", emoji: "🧗", keywords: ["bouldering", "gym"] },
  { slug: "running", label: "Running", emoji: "🏃", keywords: ["run club", "5k", "jog"] },
  { slug: "cycling", label: "Cycling", emoji: "🚴" },
  { slug: "ohio-state", label: "Ohio State", emoji: "🌰", keywords: ["osu", "buckeyes", "campus", "game day"] },
  { slug: "college", label: "College", emoji: "🎓" },
  { slug: "cheap-eats", label: "Cheap eats", emoji: "🪙", keywords: ["cheap", "budget", "affordable"] },
  { slug: "date-night", label: "Date night", emoji: "💛", keywords: ["date", "romantic"] },
  { slug: "dogs", label: "Dogs", emoji: "🐶" },
  { slug: "volunteering", label: "Volunteering", emoji: "🤝" },
  { slug: "new-in-town", label: "New in town", emoji: "🧳", keywords: ["newcomer", "moved", "meet people"] },
  { slug: "social", label: "Social", emoji: "👋" },
];

export const INTEREST_MAP: Record<string, Interest> = Object.fromEntries(
  INTERESTS.map((i) => [i.slug, i]),
);

export function getInterest(slug: string): Interest {
  return INTEREST_MAP[slug] ?? { slug, label: slug, emoji: "•" };
}

export const REPORT_REASONS: { value: string; label: string }[] = [
  { value: "inaccurate", label: "Info is wrong or outdated" },
  { value: "closed", label: "Permanently closed / no longer happens" },
  { value: "inappropriate", label: "Inappropriate or unsafe" },
  { value: "spam", label: "Spam or advertising" },
  { value: "duplicate", label: "Duplicate of another listing" },
  { value: "other", label: "Something else" },
];
