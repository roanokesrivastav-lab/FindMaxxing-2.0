import {
  Bike, BookOpen, Coffee, Coins, Dice5, Dog, Dumbbell, Footprints, Gamepad2, GraduationCap, Guitar,
  HandHeart, Handshake, Heart, Luggage, MapPin, Moon, Mountain, Music, Nut, Paintbrush, Palette, Soup,
  Sparkles, Tag, Tent, Timer, Trees, Trophy, Tv, Users, Utensils, Volleyball,
  type LucideIcon,
} from "lucide-react";
import { createElement } from "react";
import { getCategory, getInterest, type TaxonomyIconKey } from "@/lib/data/taxonomy";

const ICONS: Record<TaxonomyIconKey, LucideIcon> = {
  bike: Bike,
  "book-open": BookOpen,
  coffee: Coffee,
  coins: Coins,
  dice: Dice5,
  dog: Dog,
  dumbbell: Dumbbell,
  footprints: Footprints,
  gamepad: Gamepad2,
  "graduation-cap": GraduationCap,
  guitar: Guitar,
  "hand-heart": HandHeart,
  handshake: Handshake,
  heart: Heart,
  luggage: Luggage,
  "map-pin": MapPin,
  moon: Moon,
  mountain: Mountain,
  music: Music,
  nut: Nut,
  paintbrush: Paintbrush,
  palette: Palette,
  soup: Soup,
  sparkles: Sparkles,
  tag: Tag,
  tent: Tent,
  timer: Timer,
  trees: Trees,
  trophy: Trophy,
  tv: Tv,
  users: Users,
  utensils: Utensils,
  volleyball: Volleyball,
};

export function categoryIcon(slug: string): LucideIcon {
  return ICONS[getCategory(slug).icon] ?? MapPin;
}

export function interestIcon(slug: string): LucideIcon {
  return ICONS[getInterest(slug).icon] ?? Tag;
}

type IconProps = { slug: string; size?: number; strokeWidth?: number; className?: string };

// createElement, not <Icon />: the component is looked up per render, and a
// capitalised local would read as a component defined during render.

/** Line icon for a category. Decorative: always sits next to its text label. */
export function CategoryIcon({ slug, size = 14, strokeWidth = 2, className }: IconProps) {
  return createElement(categoryIcon(slug), { size, strokeWidth, className, "aria-hidden": true });
}

/** Line icon for an interest. Decorative: always sits next to its text label. */
export function InterestIcon({ slug, size = 14, strokeWidth = 2, className }: IconProps) {
  return createElement(interestIcon(slug), { size, strokeWidth, className, "aria-hidden": true });
}
