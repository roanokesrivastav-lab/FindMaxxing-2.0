import { describe, it, expect, beforeEach } from "vitest";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import { SEED_USERS, stableId } from "../src/lib/seed/seed-data";
import type { DataRepository } from "../src/lib/data/repository";

const maya = SEED_USERS.find((u) => u.username === "maya_r")!;
const lena = SEED_USERS.find((u) => u.username === "lena")!;
const theo = SEED_USERS.find((u) => u.username === "theo")!;

let repo: DataRepository;
beforeEach(() => {
  repo = createDemoRepository(createIsolatedStore());
});

describe("demo repository", () => {
  it("lists seeded places with creators, tags and ratings", async () => {
    const places = await repo.places.list();
    expect(places.length).toBeGreaterThan(20);
    const cannon = places.find((p) => p.id === stableId("place:Cannon & Crown"))!;
    expect(cannon.creator?.username).toBe("theo");
    expect(cannon.tags).toContain("ohio-state");
    expect(cannon.ratingCount).toBe(3);
    expect(cannon.ratingAvg).toBeCloseTo(4.67, 2);
  });

  it("rates once per user and updates in place", async () => {
    const place = stableId("place:Lantern Bowl"); // theo 4, lena 4
    let agg = await repo.places.rate(maya.id, place, 5, null);
    expect(agg).toEqual({ ratingAvg: 4.33, ratingCount: 3 });
    agg = await repo.places.rate(maya.id, place, 1, "changed my mind");
    expect(agg).toEqual({ ratingAvg: 3, ratingCount: 3 });
    const detail = await repo.places.get(place, maya.id);
    expect(detail?.viewerRating).toBe(1);
  });

  it("save is idempotent and unsave removes", async () => {
    const place = stableId("place:The Lumen Rooftop");
    await repo.places.save(maya.id, place);
    await repo.places.save(maya.id, place);
    let saved = await repo.places.listSaved(maya.id);
    expect(saved.filter((p) => p.id === place)).toHaveLength(1);
    await repo.places.unsave(maya.id, place);
    saved = await repo.places.listSaved(maya.id);
    expect(saved.some((p) => p.id === place)).toBe(false);
  });

  it("prevents duplicate joins and enforces capacity", async () => {
    const ev = stableId("event:Beginner climbing night"); // cap 12, 3 attendees
    await repo.events.join(maya.id, ev);
    await repo.events.join(maya.id, ev);
    let detail = await repo.events.get(ev, maya.id);
    expect(detail?.attendeeCount).toBe(4);
    expect(detail?.viewerJoined).toBe(true);

    const store = createIsolatedStore();
    const small = createDemoRepository(store);
    const evRow = store.state.events.find((e) => e.id === ev)!;
    evRow.capacity = 3;
    await expect(small.events.join(maya.id, ev)).rejects.toThrow(/full/);

    await repo.events.leave(maya.id, ev);
    detail = await repo.events.get(ev, maya.id);
    expect(detail?.attendeeCount).toBe(3);
    expect(detail?.viewerJoined).toBe(false);
  });

  it("blocks joining ended events", async () => {
    await expect(repo.events.join(lena.id, stableId("event:Season opener watch party"))).rejects.toThrow(/ended/);
  });

  it("creates an event with the creator attending", async () => {
    const ev = await repo.events.create(
      {
        title: "Test run",
        description: "Just testing the repo.",
        locationName: "Somewhere",
        lat: 40,
        lng: -83,
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
        categorySlug: "fitness",
        tags: ["running"],
      },
      maya.id,
    );
    expect(ev.attendeeCount).toBe(1);
    expect(ev.creator?.id).toBe(maya.id);
    const mine = await repo.events.listJoined(maya.id);
    expect(mine.some((e) => e.id === ev.id)).toBe(true);
  });

  it("supports owner place edits, photo uploader rules, rating removal, and deletion cascades", async () => {
    const store = createIsolatedStore();
    const r = createDemoRepository(store);
    const place = await r.places.create({ name: "Owner Test Place", description: "A sufficiently long place description.", categorySlug: "food", lat: 40, lng: -83, city: "Columbus", tags: ["food"], photos: [{ url: "https://example.test/photo.jpg", storagePath: "places/test.jpg" }] }, maya.id);
    await r.places.save(theo.id, place.id);
    await r.places.rate(theo.id, place.id, 5, null);
    await expect(
      r.places.update(
        place.id,
        { name: place.name, description: place.description, categorySlug: place.categorySlug, lat: place.lat, lng: place.lng, city: place.city, tags: ["cheap-eats"] },
        theo.id,
      ),
    ).rejects.toThrow(/permission/);
    const updated = await r.places.update(place.id, { name: "Updated Owner Place", description: "An updated description that is long enough.", categorySlug: "food", lat: 40.1, lng: -83.1, city: "Columbus", tags: ["cheap-eats"] }, maya.id);
    expect(updated.name).toBe("Updated Owner Place");
    expect(updated.ratingCount).toBe(1);
    expect(updated.photos).toHaveLength(1);
    const rating = await r.places.removeRating(theo.id, place.id);
    expect(rating).toEqual({ ratingAvg: 0, ratingCount: 0 });
    const photoId = updated.photos[0].id;
    await expect(r.places.removePhoto(place.id, photoId, theo.id)).rejects.toThrow(/uploader/);
    await r.places.removePhoto(place.id, photoId, maya.id);
    expect((await r.places.get(place.id, maya.id))?.photos).toHaveLength(0);
    const event = await r.events.create({ title: "Linked event", description: "A linked event description that is long enough.", placeId: place.id, locationName: "Owner Test Place", address: "1 Main St", lat: 40.1, lng: -83.1, startsAt: new Date(Date.now() + 86_400_000).toISOString(), categorySlug: "community", tags: [] }, maya.id);
    await r.places.delete(place.id, maya.id);
    expect(await r.places.get(place.id, maya.id)).toBeNull();
    expect((await r.events.get(event.id, maya.id))?.placeId).toBeNull();
    expect((await r.events.get(event.id, maya.id))?.locationName).toBe("Owner Test Place");
    expect(store.state.placeRatings.some((x) => x.placeId === place.id)).toBe(false);
    expect(store.state.savedPlaces.some((x) => x.placeId === place.id)).toBe(false);
    expect(store.state.placeTags.some((x) => x.placeId === place.id)).toBe(false);
  });

  it("preserves attendees on edit, validates capacity, cancels, and restricts deletion", async () => {
    const event = await repo.events.create({ title: "Owner controls event", description: "An event description that is long enough.", locationName: "Field", lat: 40, lng: -83, startsAt: new Date(Date.now() + 86_400_000).toISOString(), categorySlug: "fitness", capacity: 5, tags: ["running"] }, maya.id);
    await repo.events.join(theo.id, event.id);
    await expect(
      repo.events.update(
        event.id,
        { title: event.title, description: event.description, locationName: event.locationName, lat: event.lat, lng: event.lng, startsAt: event.startsAt, categorySlug: event.categorySlug, tags: [] },
        theo.id,
      ),
    ).rejects.toThrow(/permission/);
    await expect(repo.events.update(event.id, { title: event.title, description: event.description, locationName: event.locationName, lat: event.lat, lng: event.lng, startsAt: event.startsAt, categorySlug: event.categorySlug, capacity: 1, tags: [] }, maya.id)).rejects.toThrow(/capacity/);
    const edited = await repo.events.update(event.id, { title: "Edited event", description: event.description, locationName: "Edited field", lat: 40.2, lng: -83.2, startsAt: event.startsAt, categorySlug: event.categorySlug, capacity: 2, tags: ["fitness"] }, maya.id);
    expect(edited.title).toBe("Edited event");
    expect(edited.attendeeCount).toBe(2);
    expect((await repo.events.get(event.id, theo.id))?.viewerJoined).toBe(true);
    await repo.events.cancel(event.id, maya.id);
    expect((await repo.events.list()).some((e) => e.id === event.id)).toBe(false);
    expect((await repo.events.get(event.id, theo.id))?.status).toBe("cancelled");
    expect((await repo.events.listJoined(theo.id)).some((e) => e.id === event.id)).toBe(true);
    await expect(repo.events.join(lena.id, event.id)).rejects.toThrow(/not found/);
    await expect(repo.events.delete(event.id, maya.id)).rejects.toThrow(/other attendees/);
    const removable = await repo.events.create({ title: "Removable event", description: "Another event description that is long enough.", locationName: "Field", lat: 40, lng: -83, startsAt: new Date(Date.now() + 86_400_000).toISOString(), categorySlug: "fitness", tags: [] }, maya.id);
    await repo.events.delete(removable.id, maya.id);
    expect(await repo.events.get(removable.id, maya.id)).toBeNull();
  });

  it("follows are unique, non-self, and reflected in stats", async () => {
    await expect(repo.profiles.follow(maya.id, maya.id)).rejects.toThrow();
    await repo.profiles.follow(lena.id, theo.id);
    await repo.profiles.follow(lena.id, theo.id);
    const stats = await repo.profiles.stats(theo.id);
    const followers = await repo.profiles.connections(theo.id, "followers", null);
    expect(followers.filter((f) => f.profile.id === lena.id)).toHaveLength(1);
    expect(stats.followers).toBe(followers.length);
    expect(await repo.profiles.isFollowing(lena.id, theo.id)).toBe(true);
  });

  it("rejects taken usernames on profile update", async () => {
    await expect(
      repo.profiles.update(maya.id, { username: "theo", displayName: "Maya", bio: null, homeCity: null, interests: [] }),
    ).rejects.toThrow(/taken/);
  });

  it("suggests people by shared interests, excluding self and followed", async () => {
    const suggestions = await repo.profiles.suggest(maya.id, 3);
    expect(suggestions.every((p) => p.id !== maya.id)).toBe(true);
    expect(suggestions.some((p) => p.username === "theo")).toBe(false); // already followed
    // Ranked by how many interests they share with maya, most first.
    const overlaps = suggestions.map((p) => p.interests.filter((i) => maya.interests.includes(i)).length);
    expect(overlaps).toEqual([...overlaps].sort((a, b) => b - a));
    expect(overlaps[0]).toBeGreaterThan(0);
  });

  it("hides places that aren't published from non-owners", async () => {
    const store = createIsolatedStore();
    const r = createDemoRepository(store);
    const id = stableId("place:Lantern Bowl");
    store.state.places.find((p) => p.id === id)!.status = "hidden";
    expect(await r.places.get(id, maya.id)).toBeNull();
    expect(await r.places.get(id, theo.id)).not.toBeNull(); // creator
    expect((await r.places.list()).some((p) => p.id === id)).toBe(false);
  });
});

describe("tier 2 — community layer", () => {
  const nina = SEED_USERS.find((u) => u.username === "nina")!; // Cleveland, no Columbus places
  const jules = SEED_USERS.find((u) => u.username === "jules")!; // owns the locals-only trail
  const ridgeline = stableId("place:Ridgeline Loop");
  const ridgelineEvent = stableId("event:Ridgeline sunrise hike");
  const lumen = stableId("place:The Lumen Rooftop");

  it("hides locals-only places from non-locals but shows them to locals", async () => {
    // maya_r has Columbus as her home city; nina does not and has contributed nothing here.
    expect(await repo.profiles.isLocalOf(maya.id, "Columbus")).toBe(true);
    expect(await repo.profiles.isLocalOf(nina.id, "Columbus")).toBe(false);
    expect(await repo.profiles.isLocalOf(null, "Columbus")).toBe(false);

    expect(await repo.places.get(ridgeline, maya.id)).not.toBeNull();
    expect(await repo.places.get(ridgeline, nina.id)).toBeNull();
    expect(await repo.places.get(ridgeline, null)).toBeNull();

    const forLocal = await repo.places.list({ viewerId: maya.id });
    const forVisitor = await repo.places.list({ viewerId: nina.id });
    const anonymous = await repo.places.list();
    expect(forLocal.some((p) => p.id === ridgeline)).toBe(true);
    expect(forVisitor.some((p) => p.id === ridgeline)).toBe(false);
    expect(anonymous.some((p) => p.id === ridgeline)).toBe(false);
    expect(forLocal.length).toBeGreaterThan(forVisitor.length);
  });

  it("inherits a linked place's visibility for events and profile activity", async () => {
    expect((await repo.events.list({ viewerId: nina.id })).some((event) => event.id === ridgelineEvent)).toBe(false);
    expect((await repo.events.list({ viewerId: maya.id })).some((event) => event.id === ridgelineEvent)).toBe(true);
    expect(await repo.events.get(ridgelineEvent, nina.id)).toBeNull();

    const julesActivityForVisitor = await repo.profiles.activity(jules.id, nina.id);
    expect(julesActivityForVisitor.createdEvents.some((event) => event.id === ridgelineEvent)).toBe(false);
    const julesActivityForLocal = await repo.profiles.activity(jules.id, maya.id);
    expect(julesActivityForLocal.createdEvents.some((event) => event.id === ridgelineEvent)).toBe(true);
  });

  it("lets the owner see their own locals-only place regardless", async () => {
    const seen = await repo.places.get(ridgeline, jules.id);
    expect(seen?.visibility).toBe("locals");
    expect(seen?.viewerIsLocal).toBe(true);
  });

  it("allows locals to save, rate, and link events to locals-only places", async () => {
    const store = createIsolatedStore();
    const r = createDemoRepository(store);
    await r.places.save(maya.id, ridgeline);
    await r.places.rate(maya.id, ridgeline, 4, "Quietest just after sunrise.");
    expect((await r.places.listSaved(maya.id)).some((p) => p.id === ridgeline)).toBe(true);
    expect((await r.places.get(ridgeline, maya.id))?.viewerRating).toBe(4);

    const event = await r.events.create(
      {
        title: "Local trail morning",
        description: "A small morning run for people who know the trail.",
        placeId: ridgeline,
        locationName: "Ridgeline Loop",
        lat: 40.0325,
        lng: -83.0231,
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
        categorySlug: "outdoors",
        tags: ["running"],
      },
      maya.id,
    );
    expect(event.placeId).toBe(ridgeline);
  });

  it("makes a contributor a local of the city they contributed to", async () => {
    const store = createIsolatedStore();
    const r = createDemoRepository(store);
    expect(await r.profiles.isLocalOf(nina.id, "Columbus")).toBe(false);
    await r.places.create(
      { name: "Nina's find", description: "A place contributed by a visitor.", categorySlug: "food", lat: 39.96, lng: -83.0, city: "Columbus", tags: [] },
      nina.id,
    );
    // Contributing a published place in the city now qualifies her as a local.
    expect(await r.profiles.isLocalOf(nina.id, "Columbus")).toBe(true);
    expect(await r.places.get(ridgeline, nina.id)).not.toBeNull();
  });

  it("stores and lists rating notes, and only notes", async () => {
    const store = createIsolatedStore();
    const r = createDemoRepository(store);
    await r.places.rate(nina.id, lumen, 5, "  Go on a weeknight.  ");
    await r.places.rate(maya.id, lumen, 3, null);
    const notes = await r.places.listRatings(lumen, nina.id);
    expect(notes.some((n) => n.user?.username === "nina")).toBe(true);
    expect(notes.some((n) => n.user?.username === "maya_r")).toBe(false);
    const detail = await r.places.get(lumen, nina.id);
    expect(detail?.viewerRating).toBe(5);
    expect(detail?.viewerRatingNote).toBe("  Go on a weeknight.  ");
    // Seeded notes surface too.
    expect((await r.places.listRatings(stableId("place:Cannon & Crown"), maya.id)).length).toBeGreaterThan(0);
  });

  it("does not leak locals-only reviews to non-locals", async () => {
    expect(await repo.places.listRatings(ridgeline, nina.id)).toEqual([]);
    expect((await repo.places.listRatings(ridgeline, maya.id)).length).toBeGreaterThanOrEqual(0);
  });

  it("accepts up to six photos and refuses the seventh", async () => {
    const store = createIsolatedStore();
    const r = createDemoRepository(store);
    const place = await r.places.create(
      {
        name: "Gallery test", description: "A place used to check the photo cap.", categorySlug: "food",
        lat: 40, lng: -83, city: "Columbus", tags: [],
        photos: [{ url: "https://example.test/1.jpg", storagePath: "places/1.jpg" }],
      },
      maya.id,
    );
    expect(place.photos).toHaveLength(1);
    await r.places.addPhotos(
      place.id,
      Array.from({ length: 5 }, (_, i) => ({ url: `https://example.test/n${i}.jpg`, storagePath: `places/n${i}.jpg` })),
      theo.id,
    );
    expect((await r.places.get(place.id, maya.id))?.photos).toHaveLength(6);
    await expect(
      r.places.addPhotos(place.id, [{ url: "https://example.test/x.jpg", storagePath: "places/x.jpg" }], maya.id),
    ).rejects.toThrow(/at most 6/);
  });

  it("rejects oversized photo sets at place creation", async () => {
    const r = createDemoRepository(createIsolatedStore());
    await expect(
      r.places.create(
        {
          name: "Too many photos",
          description: "A place used to validate gallery limits at creation.",
          categorySlug: "food",
          lat: 40,
          lng: -83,
          city: "Columbus",
          tags: [],
          photos: Array.from({ length: 7 }, (_, i) => ({ url: `https://example.test/${i}.jpg`, storagePath: `places/${i}.jpg` })),
        },
        maya.id,
      ),
    ).rejects.toThrow(/at most 6/);
  });

  it("allows a place owner to remove a community photo", async () => {
    const store = createIsolatedStore();
    const r = createDemoRepository(store);
    await r.places.addPhotos(lumen, [{ url: "https://example.test/community.jpg", storagePath: "places/community.jpg" }], theo.id);
    const photo = (await r.places.get(lumen, maya.id))!.photos.at(-1)!;
    const lena = SEED_USERS.find((u) => u.username === "lena")!;
    await r.places.removePhoto(lumen, photo.id, lena.id);
    expect((await r.places.get(lumen, maya.id))!.photos.some((p) => p.id === photo.id)).toBe(false);
  });

  it("lets the owner hide and republish, and refuses moderation statuses", async () => {
    const store = createIsolatedStore();
    const r = createDemoRepository(store);
    await r.places.setStatus(lumen, "hidden", SEED_USERS.find((u) => u.username === "lena")!.id);
    expect((await r.places.list({ viewerId: maya.id })).some((p) => p.id === lumen)).toBe(false);
    expect(await r.places.get(lumen, maya.id)).toBeNull();
    // The owner keeps access to their own hidden listing.
    expect(await r.places.get(lumen, SEED_USERS.find((u) => u.username === "lena")!.id)).not.toBeNull();

    await expect(
      r.places.setStatus(lumen, "removed" as never, SEED_USERS.find((u) => u.username === "lena")!.id),
    ).rejects.toThrow(/Invalid status/);
    await expect(r.places.setStatus(lumen, "hidden", maya.id)).rejects.toThrow(/own/);

    await r.places.setStatus(lumen, "published", SEED_USERS.find((u) => u.username === "lena")!.id);
    expect(await r.places.get(lumen, maya.id)).not.toBeNull();
  });

  it("moves a place between trust tiers, owner only", async () => {
    const store = createIsolatedStore();
    const r = createDemoRepository(store);
    await expect(r.places.setVisibility(lumen, "locals", maya.id)).rejects.toThrow(/own/);
    const lena = SEED_USERS.find((u) => u.username === "lena")!;
    await r.places.setVisibility(lumen, "locals", lena.id);
    expect(await r.places.get(lumen, nina.id)).toBeNull();
    expect(await r.places.get(lumen, maya.id)).not.toBeNull();
  });

  it("builds follower and following lists with the viewer's follow state", async () => {
    const followers = await repo.profiles.connections(maya.id, "followers", nina.id);
    expect(followers.length).toBeGreaterThan(0);
    // nina follows maya, so maya's follower list contains nina flagged as the viewer.
    expect(followers.some((c) => c.isViewer && c.profile.username === "nina")).toBe(true);

    const following = await repo.profiles.connections(nina.id, "following", nina.id);
    expect(following.map((c) => c.profile.username).sort()).toEqual(["lena", "maya_r"]);
    expect(following.every((c) => c.viewerFollows)).toBe(true);

    const stats = await repo.profiles.stats(maya.id);
    expect(stats.followers).toBe((await repo.profiles.connections(maya.id, "followers", null)).length);
  });

  it("gives reports two read paths and never exposes the reporter", async () => {
    const filed = await repo.reports.listFiledBy(maya.id);
    expect(filed.length).toBeGreaterThan(0);
    expect(filed[0].targetLabel).toBeTruthy();
    expect(Object.keys(filed[0])).not.toContain("reporterId");

    // lena owns The Lumen Rooftop, which maya reported.
    const lena = SEED_USERS.find((u) => u.username === "lena")!;
    const against = await repo.reports.listAgainstMyContent(lena.id);
    expect(against.some((r) => r.targetId === lumen)).toBe(true);
    expect(Object.keys(against[0])).not.toContain("reporterId");

    // Someone with no reported content sees nothing.
    expect(await repo.reports.listAgainstMyContent(nina.id)).toEqual([]);
    // maya did not report her own content, so her owner-side inbox excludes what she filed.
    expect((await repo.reports.listAgainstMyContent(maya.id)).some((r) => r.targetId === lumen)).toBe(false);
  });
});
