import { Bookmark, CalendarDays, Compass, UserRound, Users, type LucideIcon } from "lucide-react";

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
