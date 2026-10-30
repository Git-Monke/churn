import { describe, expect, it } from "vitest";

import { mapJellyfinItem } from "../src/upstream/jellyfin.js";

describe("Jellyfin item mapping", () => {
  it("maps movies and series to the frontend contract", () => {
    expect(
      mapJellyfinItem({
        Id: "abc123",
        Name: "Example Movie",
        Type: "Movie",
        ProductionYear: 2020,
        RunTimeTicks: 7_200_000_000,
        CommunityRating: 8.2,
        OfficialRating: "PG-13",
        Overview: "A film.",
        ImageTags: { Primary: "tag-1" },
      }),
    ).toEqual({
      id: "abc123",
      name: "Example Movie",
      type: "Movie",
      year: 2020,
      overview: "A film.",
      rating: 8.2,
      officialRating: "PG-13",
      runtimeMinutes: 12,
      imageUrl: "/api/library/images/abc123?tag=tag-1",
    });
  });

  it("omits the image URL when there is no primary image", () => {
    const item = mapJellyfinItem({ Id: "x", Name: "Show", Type: "Series" });
    expect(item?.imageUrl).toBeUndefined();
  });

  it("drops unsupported or incomplete items", () => {
    expect(mapJellyfinItem({ Id: "x", Name: "Song", Type: "Audio" })).toBeNull();
    expect(mapJellyfinItem({ Name: "No id", Type: "Movie" })).toBeNull();
    expect(mapJellyfinItem({ Id: "x", Type: "Movie" })).toBeNull();
  });
});
