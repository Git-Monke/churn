import { describe, expect, it, vi } from "vitest";

import { createNextEpisodeLookup } from "../src/next-episode.js";
import type { JellyfinClient, JellyfinItem } from "../src/upstream/jellyfin.js";

function fakeClient(
  getEpisodes: (seriesId: string) => Promise<JellyfinItem[]>,
): JellyfinClient {
  return { getEpisodes } as unknown as JellyfinClient;
}

const episodes: JellyfinItem[] = [
  { Id: "e1", Name: "One", Type: "Episode", ParentIndexNumber: 1, IndexNumber: 1 },
];

describe("next episode lookup", () => {
  it("caches a series result for the TTL", async () => {
    let now = 1_000;
    const getEpisodes = vi.fn(async () => episodes);
    const lookup = createNextEpisodeLookup({
      ttlMs: 60_000,
      now: () => now,
    });
    const client = fakeClient(getEpisodes);

    await expect(lookup(client, "series-1")).resolves.toBe(episodes);
    now += 10_000;
    await expect(lookup(client, "series-1")).resolves.toBe(episodes);
    expect(getEpisodes).toHaveBeenCalledTimes(1);

    now += 60_000;
    await lookup(client, "series-1");
    expect(getEpisodes).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent lookups and does not cache failures", async () => {
    let resolve: ((items: JellyfinItem[]) => void) | undefined;
    const getEpisodes = vi
      .fn<() => Promise<JellyfinItem[]>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolvePromise) => {
            resolve = resolvePromise;
          }),
      )
      .mockResolvedValueOnce(episodes);
    const lookup = createNextEpisodeLookup();
    const client = fakeClient(getEpisodes);

    const first = lookup(client, "series-1");
    const second = lookup(client, "series-1");
    expect(getEpisodes).toHaveBeenCalledTimes(1);
    resolve?.(episodes);
    await expect(Promise.all([first, second])).resolves.toEqual([
      episodes,
      episodes,
    ]);

    const failing = createNextEpisodeLookup();
    const failingGetEpisodes = vi.fn(async (): Promise<JellyfinItem[]> => {
      throw new Error("upstream unavailable");
    });
    const errorClient = fakeClient(failingGetEpisodes);
    await expect(failing(errorClient, "series-2")).resolves.toBeUndefined();
    await expect(failing(errorClient, "series-2")).resolves.toBeUndefined();
    expect(failingGetEpisodes).toHaveBeenCalledTimes(2);
  });
});
