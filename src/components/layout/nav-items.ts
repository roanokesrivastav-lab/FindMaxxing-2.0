import { Bookmark, CalendarDays, Compass, Hash, MapPinned, Sparkles, UserRound, Users, type LucideIcon } from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  match: (pathname: string) => boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Explore", icon: Compass, match: (p) => p === "/" || p.startsWith("/places") },
  { href: "/events", label: "Events", icon: CalendarDays, match: (p) => p.startsWith("/events") },
  { href: "/people", label: "People", icon: Users, match: (p) => p.startsWith("/people") || p.startsWith("/u/") },
  { href: "/saved", label: "Saved", icon: Bookmark, match: (p) => p.startsWith("/saved") },
  { href: "/profile", label: "Profile", icon: UserRound, match: (p) => p.startsWith("/profile") || p.startsWith("/auth") },
];

/** Secondary discovery surfaces. Desktop side rail only; mobile reaches them from Explore. */
export const BROWSE_ITEMS: NavItem[] = [
  { href: "/new", label: "New this week", icon: Sparkles, match: (p) => p === "/new" },
  { href: "/tags", label: "Interests", icon: Hash, match: (p) => p.startsWith("/tags") },
  { href: "/neighborhoods", label: "Neighborhoods", icon: MapPinned, match: (p) => p.startsWith("/neighborhoods") },
];
