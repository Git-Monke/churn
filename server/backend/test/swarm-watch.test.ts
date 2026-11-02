import { describe, expect, it, vi } from "vitest";

import { movieReleaseCandidate, showReleaseCandidate } from "../src/release-pick.js";
import {
  findQueueRecord,
  findTorrent,
  pickRepickRelease,
  shouldRepick,
  watchSwarm,
} from "../src/swarm-watch.js";
import type { ReleaseRepickEvent } from "../src/release-events.js";
import type { QbittorrentTorrent } from "../src/upstream/qbittorrent.js";
import type { ServarrQueueRecord, ServarrRelease } from "../src/upstream/servarr.js";

function release(overrides: Partial<ServarrRelease> = {}): ServarrRelease {
  return {
    guid: "magnet:?xt=urn:btih:seventh-seal-720",
    indexerId: 1,
    indexer: "YTS",
    title: "The.Seventh.Seal.1957.720p.BluRay",
    size: 800_000_000,
    quality: { quality: { id: 4, name: "Bluray-720p" } },
    approved: true,
    rejected: false,
    downloadAllowed: true,
    rejections: [],
    protocol: "torrent",
    seeders: 20,
    leechers: 4,
    ...overrides,
  };
}

const dead720 = release();
const healthy1080 = release({
  guid: "magnet:?xt=urn:btih:seventh-seal-1080",
  indexerId: 2,
  title: "The.Seventh.Seal.1957.1080p.BluRay",
  size: 2_000_000_000,
  quality: { quality: { id: 7, name: "Bluray-1080p" } },
  approved: false,
  rejected: true,
  downloadAllowed: false,
  rejections: ["Quality Bluray-1080p is not wanted in profile"],
  seeders: 84,
});

const policy = {
  minSeeders: 5,
  maxSpeedForRepick: 300 * 1024,
  maxProgressForRepick: 0.25,
};

describe("swarm watch", () => {
  it("flags a slow swarm but not a few fast seeds or a nearly finished download", () => {
    expect(
      shouldRepick(
        { connectedSeeds: 3, downloadSpeed: 100 * 1024, progress: 0.1 },
        policy,
      ),
    ).toBe(true);
    expect(
      shouldRepick(
        { connectedSeeds: 3, downloadSpeed: 5 * 1024 * 1024, progress: 0.1 },
        policy,
      ),
    ).toBe(false);
    expect(
      shouldRepick(
        { connectedSeeds: 12, downloadSpeed: 10 * 1024, progress: 0.1 },
        policy,
      ),
    ).toBe(false);
    expect(
      shouldRepick(
        { connectedSeeds: 1, downloadSpeed: 10 * 1024, progress: 0.6 },
        policy,
      ),
    ).toBe(false);
  });

  it("re-picks the well-seeded higher tier without downgrading", () => {
    const alternative = pickRepickRelease(
      [dead720, healthy1080].map((item) => movieReleaseCandidate(item)),
      {
        current: dead720,
        attempted: [],
        currentTier: 1,
        preferredTier: 1,
        maxTier: 2,
        minSeeders: 5,
        gainFactor: 1.5,
      },
    );

    expect(alternative).toMatchObject({
      release: { guid: healthy1080.guid },
      reason: "tier_upgrade",
      requiresOverride: true,
    });
  });

  it("refuses alternatives that are not better seeded, are below tier, or were tried", () => {
    const options = {
      current: dead720,
      attempted: [] as string[],
      currentTier: 2,
      preferredTier: 1,
      maxTier: 2,
      minSeeders: 5,
      gainFactor: 1.5,
    };

    // A current 4K download must not be replaced by a lower tier.
    expect(
      pickRepickRelease(
        [dead720, healthy1080].map((item) => movieReleaseCandidate(item)),
        { ...options, currentTier: 3 },
      ),
    ).toBeUndefined();

    // Only 1.2× the reported seeders is not a meaningful gain.
    const barelyBetter = release({
      guid: "barely",
      title: "The.Seventh.Seal.1957.1080p.Other",
      size: 2_000_000_000,
      quality: { quality: { id: 7, name: "Bluray-1080p" } },
      approved: true,
      rejected: false,
      downloadAllowed: true,
      rejections: [],
      seeders: 24,
    });
    expect(
      pickRepickRelease(
        [dead720, barelyBetter].map((item) => movieReleaseCandidate(item)),
        { ...options, currentTier: 1 },
      ),
    ).toBeUndefined();

    // Already attempted releases are skipped.
    const attempted = pickRepickRelease(
      [dead720, healthy1080].map((item) => movieReleaseCandidate(item)),
      { ...options, currentTier: 1, attempted: ["not-used", "some-other-id"] },
    );
    expect(attempted?.release.guid).toBe(healthy1080.guid);
  });

  it("matches the queue record by title and hash", () => {
    const record: ServarrQueueRecord = {
      id: 7,
      movieId: 42,
      downloadId: "ABCDEF",
      title: "The.Seventh.Seal.1957.720p.BluRay",
    };
    expect(
      findQueueRecord([record], {
        target: { movieId: 42 },
        release: dead720,
      }),
    ).toBe(record);

    const torrents: QbittorrentTorrent[] = [
      { hash: "abcdef", num_seeds: 3 },
      { hash: "other", num_seeds: 90 },
    ];
    expect(findTorrent(torrents, "ABCDEF")).toBe(torrents[0]);
  });

  it("removes the stalled queue item and grabs the better release", async () => {
    const removed: number[] = [];
    const grabbed: Array<{ release: ServarrRelease; override: boolean }> = [];
    const events: Array<Omit<ReleaseRepickEvent, "id" | "at">> = [];
    const torrents: QbittorrentTorrent[] = [
      { hash: "abc", num_seeds: 3, dlspeed: 100 * 1024, progress: 0.08 },
    ];

    const result = await watchSwarm(
      {
        service: "radarr",
        mediaTitle: "The Seventh Seal",
        target: { movieId: 42 },
        release: dead720,
        candidates: [dead720, healthy1080],
        preferredTier: 1,
        minSeeders: 5,
      },
      {
        getQueue: async () => [
          {
            id: 7,
            movieId: 42,
            downloadId: "abc",
            title: dead720.title,
          },
        ],
        getTorrents: async () => torrents,
        removeQueueRecord: async (queueId) => {
          removed.push(queueId);
        },
        grab: async (item, override) => {
          grabbed.push({ release: item, override });
        },
        onRepick: (event) => events.push(event),
        sleep: async () => {},
        policy: {
          startDelayMs: 0,
          findTimeoutMs: 0,
          findIntervalMs: 0,
          warmupMs: 0,
          sampleIntervalMs: 0,
          removeSettleMs: 0,
          maxSamples: 2,
          unhealthySamples: 2,
        },
      },
    );

    expect(result.status).toBe("repicked");
    expect(removed).toEqual([7]);
    expect(grabbed).toEqual([{ release: healthy1080, override: true }]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      fromTitle: dead720.title,
      toTitle: healthy1080.title,
      connectedSeeds: 3,
      downloadSpeed: 100 * 1024,
      fromReportedSeeders: 20,
      toReportedSeeders: 84,
    });
  });

  it("leaves a healthy download alone", async () => {
    const grab = vi.fn(async () => {});
    const result = await watchSwarm(
      {
        service: "radarr",
        mediaTitle: "The Seventh Seal",
        target: { movieId: 42 },
        release: dead720,
        candidates: [dead720, healthy1080],
        preferredTier: 1,
        minSeeders: 5,
      },
      {
        getQueue: async () => [
          { id: 7, movieId: 42, downloadId: "abc", title: dead720.title },
        ],
        getTorrents: async () => [
          { hash: "abc", num_seeds: 12, dlspeed: 4 * 1024 * 1024, progress: 0.2 },
        ],
        removeQueueRecord: async () => {},
        grab,
        sleep: async () => {},
        policy: {
          startDelayMs: 0,
          findTimeoutMs: 0,
          findIntervalMs: 0,
          warmupMs: 0,
          sampleIntervalMs: 0,
          removeSettleMs: 0,
          maxSamples: 2,
          unhealthySamples: 2,
        },
      },
    );

    expect(result.status).toBe("unchanged");
    expect(grab).not.toHaveBeenCalled();
  });

  it("uses show candidates for season packs", async () => {
    const pack = release({
      guid: "pack-720",
      title: "Severance.S01.720p.WEB-DL",
      seasonNumber: 1,
      seasonNumbers: [1],
      fullSeason: true,
      mappedEpisodeInfo: [{ id: 101, seasonNumber: 1, episodeNumber: 1 }],
      seeders: 2,
    });
    const betterPack = release({
      guid: "pack-1080",
      title: "Severance.S01.1080p.WEB-DL",
      quality: { quality: { id: 7, name: "WEBDL-1080p" } },
      seasonNumber: 1,
      seasonNumbers: [1],
      fullSeason: true,
      mappedEpisodeInfo: [{ id: 101, seasonNumber: 1, episodeNumber: 1 }],
      approved: false,
      rejected: true,
      downloadAllowed: false,
      rejections: ["Quality WEBDL-1080p is not wanted in profile"],
      seeders: 90,
    });

    expect(
      pickRepickRelease(
        [pack, betterPack].map((item) =>
          showReleaseCandidate(item, item.mappedEpisodeInfo?.length ?? 0),
        ),
        {
          current: pack,
          attempted: [],
          currentTier: 1,
          preferredTier: 1,
          maxTier: 2,
          minSeeders: 5,
          gainFactor: 1.5,
        },
      ),
    ).toMatchObject({ release: { guid: betterPack.guid }, requiresOverride: true });
  });
});
