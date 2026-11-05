import { describe, expect, it } from "vitest";

import { parseHash, playHash, showHash } from "./use-hash-route";

describe("hash routing", () => {
  it("parses the basic pages", () => {
    expect(parseHash("")).toEqual({ page: "library" });
    expect(parseHash("#/library")).toEqual({ page: "library" });
    expect(parseHash("#/services")).toEqual({ page: "services" });
    expect(parseHash("#/search")).toEqual({ page: "search" });
    expect(parseHash("#/people")).toEqual({ page: "people" });
  });

  it("keeps the season on show routes", () => {
    expect(showHash("jellyfin", "abc")).toBe("#/library/show/jellyfin/abc");
    expect(showHash("sonarr", "12", 3)).toBe(
      "#/library/show/sonarr/12/season/3",
    );

    expect(parseHash("#/library/show/jellyfin/abc")).toEqual({
      page: "show",
      source: "jellyfin",
      id: "abc",
    });
    expect(parseHash("#/library/show/sonarr/12/season/3")).toEqual({
      page: "show",
      source: "sonarr",
      id: "12",
      season: 3,
    });
    // An unusable season falls back to the show's default season.
    expect(parseHash("#/library/show/jellyfin/abc/season/nope")).toEqual({
      page: "show",
      source: "jellyfin",
      id: "abc",
    });
  });

  it("round-trips the player's return context", () => {
    const from = { source: "sonarr" as const, id: "12", season: 3 };
    expect(parseHash(playHash("ep1", from))).toEqual({
      page: "play",
      id: "ep1",
      from,
    });
    expect(parseHash("#/play/ep1")).toEqual({ page: "play", id: "ep1" });
    // A malformed context must not break the player.
    expect(parseHash("#/play/ep1?source=bogus&show=1")).toEqual({
      page: "play",
      id: "ep1",
    });
  });

  it("decodes encoded ids", () => {
    expect(parseHash("#/play/a%20b")).toEqual({ page: "play", id: "a b" });
    expect(parseHash("#/library/show/jellyfin/a%20b")).toEqual({
      page: "show",
      source: "jellyfin",
      id: "a b",
    });
  });
});
