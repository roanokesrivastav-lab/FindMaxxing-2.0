-- Seed the shared app vocabulary without inserting any fictional demo users,
-- places, or events. Keep these values aligned with packages/shared/src/taxonomy.ts.
insert into public.categories (slug, label, emoji, color, scope, sort_order) values
  ('pickup-sports', 'Pickup sports', '⚽', '#1f8a5b', 'both', 0),
  ('sports-bar', 'Sports bar', '📺', '#ff4d2e', 'place', 1),
  ('watch-party', 'Watch party', '🏈', '#ff4d2e', 'event', 2),
  ('outdoors', 'Outdoors', '🌲', '#2f7d4f', 'both', 3),
  ('fitness', 'Fitness', '🧗', '#0e8f8a', 'both', 4),
  ('food', 'Food', '🌮', '#e0741f', 'both', 5),
  ('coffee-study', 'Coffee & study', '☕', '#8b5a2b', 'both', 6),
  ('nightlife', 'Nightlife', '🌙', '#6b4cff', 'both', 7),
  ('music', 'Music', '🎸', '#c0399b', 'both', 8),
  ('arts', 'Arts', '🎨', '#d1436b', 'both', 9),
  ('gaming-hobby', 'Gaming & hobbies', '🎲', '#3b6fd6', 'both', 10),
  ('date-spot', 'Date spot', '💛', '#e8a600', 'place', 11),
  ('community', 'Community', '🤝', '#4c8ac9', 'both', 12),
  ('college', 'College life', '🎓', '#b13a3a', 'both', 13),
  ('other', 'Other', '📍', '#7b7c85', 'both', 14)
on conflict (slug) do update set
  label = excluded.label,
  emoji = excluded.emoji,
  color = excluded.color,
  scope = excluded.scope,
  sort_order = excluded.sort_order;

insert into public.interests (slug, label, emoji, sort_order) values
  ('sports', 'Sports', '🏀', 0),
  ('pickup-sports', 'Pickup games', '⚽', 1),
  ('fitness', 'Fitness', '💪', 2),
  ('hiking', 'Hiking', '🥾', 3),
  ('outdoors', 'Outdoors', '🏕️', 4),
  ('food', 'Food', '🍜', 5),
  ('coffee', 'Coffee', '☕', 6),
  ('studying', 'Studying', '📚', 7),
  ('nightlife', 'Nightlife', '🪩', 8),
  ('music', 'Music', '🎶', 9),
  ('art', 'Art', '🖌️', 10),
  ('gaming', 'Gaming', '🎮', 11),
  ('board-games', 'Board games', '🎲', 12),
  ('climbing', 'Climbing', '🧗', 13),
  ('running', 'Running', '🏃', 14),
  ('cycling', 'Cycling', '🚴', 15),
  ('ohio-state', 'Ohio State', '🌰', 16),
  ('college', 'College', '🎓', 17),
  ('cheap-eats', 'Cheap eats', '🪙', 18),
  ('date-night', 'Date night', '💛', 19),
  ('dogs', 'Dogs', '🐶', 20),
  ('volunteering', 'Volunteering', '🤝', 21),
  ('new-in-town', 'New in town', '🧳', 22),
  ('social', 'Social', '👋', 23)
on conflict (slug) do update set
  label = excluded.label,
  emoji = excluded.emoji,
  sort_order = excluded.sort_order;
