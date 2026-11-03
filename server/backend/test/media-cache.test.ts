import { describe, expect, it } from "vitest";

import { seriesMetadataEntry } from "../src/media-cache.js";

describe("media cache", () => {
  it("records seasons where Sonarr already has every episode file", () => {
    const entry = seriesMetadataEntry({
      id: 42,
      title: "Example Show",
      seasons: [
        {
          seasonNumber: 1,
          monitored: true,
          statistics: { episodeFileCount: 10, totalEpisodeCount: 10 },
        },
        {
          seasonNumber: 2,
          monitored: true,
          statistics: { episodeFileCount: 2, totalEpisodeCount: 10 },
        },
        {
          seasonNumber: 3,
          monitored: true,
          statistics: { episodeFileCount: 4, episodeCount: 4 },
        },
        { seasonNumber: 4, monitored: true },
      ],
    });

    expect(entry?.seasons).toEqual([1, 2, 3, 4]);
    expect(entry?.completeSeasons).toEqual([1, 3]);
  });
});
