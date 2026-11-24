import { describe, expect, it } from "vitest";

import { routeUrlFor, unsupportedVersion } from "../src/api-version.js";

describe("versioned API paths", () => {
  it("route /api/v1/... to the same handlers as /api/...", () => {
    expect(routeUrlFor("/api/v1/library")).toBe("/api/library");
    expect(routeUrlFor("/api/v1/search?q=dune&x=1")).toBe("/api/search?q=dune&x=1");
    expect(routeUrlFor("/api/v1/library/shows/sonarr/12")).toBe("/api/library/shows/sonarr/12");
    expect(routeUrlFor("/api/v1")).toBe("/api");
  });

  it("leave everything else alone", () => {
    expect(routeUrlFor("/api/library")).toBe("/api/library");
    expect(routeUrlFor("/api/v1x/library")).toBe("/api/v1x/library");
    expect(routeUrlFor("/api/v2/library")).toBe("/api/v2/library");
    expect(routeUrlFor("/assets/v1/app.js")).toBe("/assets/v1/app.js");
  });

  it("name a version the server doesn't serve", () => {
    expect(unsupportedVersion("/api/v2/library")).toBe(2);
    expect(unsupportedVersion("/api/v0/meta?x")).toBe(0);
    expect(unsupportedVersion("/api/v1/library")).toBeUndefined();
    expect(unsupportedVersion("/api/library")).toBeUndefined();
  });
});
