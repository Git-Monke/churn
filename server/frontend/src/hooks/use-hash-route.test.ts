import { describe, expect, it } from "vitest";

import { parseHash, playHash, showHash, stripRestartParam } from "./use-hash-route";

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

  it("carries the autoplay restart intent without changing resume links", () => {
    const from = { source: "jellyfin" as const, id: "series-1", season: 2 };
    expect(parseHash(playHash("ep2", from, true))).toEqual({
      page: "play",
      id: "ep2",
      from,
      restart: true,
    });
    // Autoplay with no show context still restarts and stays a plain play hash.
    expect(parseHash(playHash("ep2", undefined, true))).toEqual({
      page: "play",
      id: "ep2",
      restart: true,
    });
    // Ordinary links resume, so the route has no restart key at all.
    expect(parseHash(playHash("ep2", from))).toEqual({ page: "play", id: "ep2", from });
    expect(parseHash("#/play/ep2?restart=0")).toEqual({ page: "play", id: "ep2" });
  });

  it("consumes the restart intent without losing the return context", () => {
    const from = { source: "jellyfin" as const, id: "series-1", season: 2 };
    const consumed = stripRestartParam(playHash("ep2", from, true));

    expect(parseHash(consumed)).toEqual({ page: "play", id: "ep2", from });
    // A second visit to the player must not restart it again.
    expect(stripRestartParam(consumed)).toBe(consumed);
    // A restart with no other parameters drops the query entirely.
    expect(stripRestartParam("#/play/ep2?restart=1")).toBe("#/play/ep2");
    // Hashes without the intent are left untouched.
    expect(stripRestartParam("#/play/ep2")).toBe("#/play/ep2");
    expect(stripRestartParam("#/library/show/jellyfin/abc")).toBe(
      "#/library/show/jellyfin/abc",
    );
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
