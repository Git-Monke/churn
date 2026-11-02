import type { ReleaseRepickEvent } from "./release-events.js";
import {
  movieReleaseCandidate,
  releaseIsTorrent,
  releaseTier,
  showReleaseCandidate,
  type ReleaseCandidate,
  type ReleasePick,
} from "./release-pick.js";
import { mappedEpisodeIds, releaseId } from "./releases.js";
import type { QbittorrentTorrent } from "./upstream/qbittorrent.js";
import type { ServarrQueueRecord, ServarrRelease } from "./upstream/servarr.js";

export interface SwarmWatchPolicy {
  /** Let the arr send the torrent to qBittorrent before looking for it. */
  startDelayMs: number;
  /** Give up if the grab never appears in the arr queue. */
  findTimeoutMs: number;
  findIntervalMs: number;
  /** Let connections and metadata settle before judging the swarm. */
  warmupMs: number;
  sampleIntervalMs: number;
  maxSamples: number;
  /** Consecutive unhealthy samples needed before switching releases. */
  unhealthySamples: number;
  /** Speeds above this are considered healthy even with few seeds. */
  maxSpeedForRepick: number;
  /** Never re-pick once the download is this far along. */
  maxProgressForRepick: number;
  /** The alternative must have at least this multiple of the current reported seeders. */
  minSeederGainFactor: number;
  /** How many releases churn may switch to before it stops trying. */
  maxRepicks: number;
  /** Let the arr settle after removing the stalled queue item. */
  removeSettleMs: number;
}

export const DEFAULT_SWARM_POLICY: SwarmWatchPolicy = {
  startDelayMs: 3_000,
  findTimeoutMs: 30_000,
  findIntervalMs: 5_000,
  warmupMs: 60_000,
  sampleIntervalMs: 15_000,
  maxSamples: 4,
  unhealthySamples: 2,
  maxSpeedForRepick: 300 * 1024,
  maxProgressForRepick: 0.25,
  minSeederGainFactor: 1.5,
  maxRepicks: 1,
  removeSettleMs: 2_000,
};

export interface SwarmSample {
  /** Seeds actually connected to qBittorrent, not the tracker's swarm count. */
  connectedSeeds?: number;
  downloadSpeed?: number;
  /** Fraction complete, 0–1. */
  progress?: number;
}

export interface SwarmWatchInput {
  service: "sonarr" | "radarr";
  /** Movie or series title, used in the dashboard notice. */
  mediaTitle: string;
  target: { movieId?: number; seriesId?: number };
  seasonNumber?: number;
  release: ServarrRelease;
  /** Release list the original pick came from, used to find an alternative. */
  candidates: ServarrRelease[];
  preferredTier?: number;
  minSeeders: number;
  /** Release ids already tried, so churn never switches back. */
  attempted?: string[];
}

export interface SwarmWatchDeps {
  getQueue(): Promise<ServarrQueueRecord[]>;
  getTorrents(): Promise<QbittorrentTorrent[]>;
  removeQueueRecord(queueId: number): Promise<void>;
  grab(release: ServarrRelease, override: boolean): Promise<void>;
  onRepick?(event: Omit<ReleaseRepickEvent, "id" | "at">): void;
  sleep?(ms: number): Promise<void>;
  policy?: Partial<SwarmWatchPolicy>;
}

export type SwarmWatchStatus =
  | "unchanged"
  | "repicked"
  | "no_alternative"
  | "not_found"
  | "failed";

export interface SwarmWatchResult {
  status: SwarmWatchStatus;
  /** Release title the watcher ended on. */
  release?: string;
  connectedSeeds?: number;
  downloadSpeed?: number;
}

/**
 * Should churn abandon the current torrent? A slow swarm means few *connected*
 * seeds and a low speed. Once the download is far enough along, switching
 * releases wastes more than it saves.
 */
export function shouldRepick(
  sample: SwarmSample,
  policy: {
    minSeeders: number;
    maxSpeedForRepick: number;
    maxProgressForRepick: number;
  },
): boolean {
  if ((sample.progress ?? 0) >= policy.maxProgressForRepick) {
    return false;
  }
  if (sample.connectedSeeds === undefined) {
    return false;
  }
  if (sample.connectedSeeds >= policy.minSeeders) {
    return false;
  }
  return (sample.downloadSpeed ?? 0) < policy.maxSpeedForRepick;
}

/**
 * Choose the most reliable alternative. Unlike the first pick, this ignores the
 * preferred-tier bias and simply takes the release with the most reported
 * seeders, never below the current quality tier and never more than one tier
 * above the requested profile.
 */
export function pickRepickRelease(
  candidates: ReleaseCandidate<ServarrRelease>[],
  options: {
    current: ServarrRelease;
    attempted: Iterable<string>;
    currentTier?: number;
    preferredTier?: number;
    maxTier?: number;
    minSeeders: number;
    gainFactor: number;
  },
): ReleasePick<ServarrRelease> | undefined {
  const currentId = releaseId(options.current);
  const attempted = new Set(options.attempted);
  const currentSeeders = options.current.seeders ?? 0;
  const requiredSeeders = Math.max(
    options.minSeeders,
    Math.ceil(currentSeeders * options.gainFactor),
  );

  const eligible = candidates.filter((candidate) => {
    const id = releaseId(candidate.release);
    if (!id || id === currentId || attempted.has(id)) {
      return false;
    }
    if (!candidate.grabAllowed || !releaseIsTorrent(candidate.release)) {
      return false;
    }
    if (!candidate.approved && !candidate.overrideAllowed) {
      return false;
    }
    if ((candidate.seeders ?? 0) < requiredSeeders) {
      return false;
    }
    if (candidate.tier === undefined) {
      return false;
    }
    if (options.currentTier !== undefined && candidate.tier < options.currentTier) {
      return false;
    }
    if (options.maxTier !== undefined && candidate.tier > options.maxTier) {
      return false;
    }
    return true;
  });

  if (eligible.length === 0) {
    return undefined;
  }

  const preferred = options.preferredTier ?? options.currentTier;
  const best = [...eligible].sort((left, right) => {
    const seeders = (right.seeders ?? 0) - (left.seeders ?? 0);
    if (seeders !== 0) {
      return seeders;
    }
    const tier = tierDistance(left, preferred) - tierDistance(right, preferred);
    if (tier !== 0) {
      return tier;
    }
    return left.sizeBytes - right.sizeBytes;
  })[0] as ReleaseCandidate<ServarrRelease>;

  return {
    release: best.release,
    reason:
      preferred !== undefined && (best.tier ?? 0) > preferred
        ? "tier_upgrade"
        : "best_effort",
    requiresOverride: !best.approved,
  };
}

/** Find the queue record the grab created, matching the target and release title. */
export function findQueueRecord(
  records: ServarrQueueRecord[],
  input: Pick<SwarmWatchInput, "target" | "seasonNumber" | "release">,
): ServarrQueueRecord | undefined {
  const targetRecords = records.filter((record) =>
    input.target.movieId !== undefined
      ? record.movieId === input.target.movieId
      : input.target.seriesId !== undefined
        ? record.seriesId === input.target.seriesId
        : false,
  );
  const title = normalizeTitle(input.release.title);
  const exact = targetRecords.find(
    (record) => normalizeTitle(record.title) === title,
  );
  if (exact) {
    return exact;
  }

  const bySeason =
    input.seasonNumber === undefined
      ? targetRecords
      : targetRecords.filter((record) => record.seasonNumber === input.seasonNumber);
  return bySeason.length === 1 ? bySeason[0] : undefined;
}

/** Index a torrent by any hash variant the arr queue may report. */
export function findTorrent(
  torrents: QbittorrentTorrent[],
  hash: string | undefined,
): QbittorrentTorrent | undefined {
  const wanted = hash?.trim().toLowerCase();
  if (!wanted) {
    return undefined;
  }
  return torrents.find((torrent) =>
    [torrent.hash, torrent.infohash_v1, torrent.infohash_v2]
      .map((value) => value?.trim().toLowerCase())
      .includes(wanted),
  );
}

/**
 * Watch an accepted grab and switch to a better-seeded release when the swarm
 * turns out to be mostly tracker inflation. Resolves once the download looks
 * healthy, the alternatives run out, or the re-pick budget is spent.
 */
export async function watchSwarm(
  input: SwarmWatchInput,
  deps: SwarmWatchDeps,
): Promise<SwarmWatchResult> {
  const policy = { ...DEFAULT_SWARM_POLICY, ...deps.policy };
  const sleep = deps.sleep ?? sleepWithUnref;
  const attempted = new Set(input.attempted ?? []);
  let current = input.release;
  const currentId = releaseId(current);
  if (currentId) {
    attempted.add(currentId);
  }
  const currentTier = releaseTier(current);
  const maxTier =
    input.preferredTier === undefined ? undefined : input.preferredTier + 1;
  let repicks = 0;

  await sleep(policy.startDelayMs);

  while (repicks < policy.maxRepicks) {
    const record = await waitForQueueRecord(input, policy, deps, sleep);
    if (!record?.downloadId) {
      return { status: "not_found", release: current.title };
    }

    await sleep(policy.warmupMs);

    let unhealthy = 0;
    let sample: SwarmSample = {};
    for (let index = 0; index < policy.maxSamples; index += 1) {
      let torrent: QbittorrentTorrent | undefined;
      try {
        torrent = findTorrent(await deps.getTorrents(), record.downloadId);
      } catch {
        return { status: "failed", release: current.title };
      }
      if (!torrent) {
        return { status: "not_found", release: current.title };
      }

      sample = {
        connectedSeeds: torrent.num_seeds,
        downloadSpeed: torrent.dlspeed,
        progress: torrent.progress,
      };
      if (!shouldRepick(sample, { ...policy, minSeeders: input.minSeeders })) {
        unhealthy = 0;
      } else {
        unhealthy += 1;
      }

      if (unhealthy >= policy.unhealthySamples) {
        break;
      }
      if (index < policy.maxSamples - 1) {
        await sleep(policy.sampleIntervalMs);
      }
    }

    if (unhealthy < policy.unhealthySamples) {
      return {
        status: "unchanged",
        release: current.title,
        connectedSeeds: sample.connectedSeeds,
        downloadSpeed: sample.downloadSpeed,
      };
    }

    const alternative = pickRepickRelease(
      input.candidates.map((release) =>
        input.service === "sonarr"
          ? showReleaseCandidate(release, mappedEpisodeIds(release).length)
          : movieReleaseCandidate(release),
      ),
      {
        current,
        attempted,
        currentTier,
        preferredTier: input.preferredTier,
        maxTier,
        minSeeders: input.minSeeders,
        gainFactor: policy.minSeederGainFactor,
      },
    );
    if (!alternative) {
      return {
        status: "no_alternative",
        release: current.title,
        connectedSeeds: sample.connectedSeeds,
        downloadSpeed: sample.downloadSpeed,
      };
    }

    if (record.id === undefined) {
      return { status: "failed", release: current.title };
    }

    try {
      await deps.removeQueueRecord(record.id);
    } catch {
      return { status: "failed", release: current.title };
    }
    await sleep(policy.removeSettleMs);
    try {
      await deps.grab(alternative.release, alternative.requiresOverride);
    } catch {
      return { status: "failed", release: current.title };
    }

    const alternativeId = releaseId(alternative.release);
    if (alternativeId) {
      attempted.add(alternativeId);
    }
    deps.onRepick?.({
      service: input.service,
      mediaTitle: input.mediaTitle,
      seasonNumber: input.seasonNumber,
      fromTitle: current.title?.trim() || "Release",
      toTitle: alternative.release.title?.trim() || "Release",
      fromReportedSeeders: current.seeders,
      connectedSeeds: sample.connectedSeeds,
      downloadSpeed: sample.downloadSpeed,
      toReportedSeeders: alternative.release.seeders,
    });

    current = alternative.release;
    repicks += 1;
  }

  return {
    status: repicks > 0 ? "repicked" : "unchanged",
    release: current.title,
  };
}

async function waitForQueueRecord(
  input: SwarmWatchInput,
  policy: SwarmWatchPolicy,
  deps: SwarmWatchDeps,
  sleep: (ms: number) => Promise<void>,
): Promise<ServarrQueueRecord | undefined> {
  const deadline = Date.now() + policy.findTimeoutMs;
  while (Date.now() <= deadline) {
    try {
      const record = findQueueRecord(await deps.getQueue(), input);
      if (record?.downloadId) {
        return record;
      }
    } catch {
      // Keep trying until the deadline; the grab may still be in flight.
    }
    if (Date.now() >= deadline) {
      break;
    }
    await sleep(policy.findIntervalMs);
  }
  return undefined;
}

function tierDistance(
  candidate: ReleaseCandidate<ServarrRelease>,
  tier: number | undefined,
): number {
  if (tier === undefined || candidate.tier === undefined) {
    return 0;
  }
  return Math.abs(candidate.tier - tier);
}

function normalizeTitle(title: string | undefined): string {
  return (title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Timers must not keep Node (or a test process) alive while a watch is pending. */
function sleepWithUnref(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
