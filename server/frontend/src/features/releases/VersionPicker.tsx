import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  DownloadIcon,
  Loader2Icon,
  RefreshCwIcon,
  RotateCwIcon,
} from "lucide-react";

import type {
  ReleaseIndexerProgress,
  ReleaseSearchProgress,
  ShowRelease,
} from "@/api/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { releaseAvailability } from "@/features/releases/availability";
import { defaultTier, RELEASE_TIER_META } from "@/features/releases/release-tiers";
import {
  useReleaseSearch,
  type ReleaseSearchTarget,
} from "@/features/releases/use-release-search";
import {
  formatBytes,
  formatRelativeAge,
  formatReleaseAge,
} from "@/lib/format";
import { cn } from "@/lib/utils";

const MOVIE_SUBTITLE =
  "We picked the most reliable one for each quality. It'll be ready to watch once it downloads.";

/** Alternatives are paginated; the first page renders without extra clicks. */
const ALTERNATIVE_PAGE_SIZE = 20;

export interface VersionPickerProps {
  /** Which search the picker runs: a movie, or a season. */
  scope: "movie" | "season";
  movieId?: number;
  seriesId?: number;
  seasonNumber?: number;
  /** Narrow a season search to one episode. */
  episodeNumber?: number;
  title?: ReactNode;
  subtitle?: ReactNode;
  /** `Download`, or `Download season` for a season pack. */
  primaryLabel?: string;
  /** Slot after the alternatives toggle (e.g. "Pick episodes one at a time"). */
  footerExtra?: ReactNode;
  /** Renders the "Close" button; used when the picker was opened on demand. */
  onClose?: () => void;
  onGrabbed?: () => void;
}

/**
 * The shared quality picker: tier buttons, the best release for the chosen
 * tier, collapsible alternatives and the indexer status popover.
 *
 * It is configured, not forked, so the season picker only changes copy and the
 * search target. Search and grab behaviour comes from `useReleaseSearch`, which
 * the movie, season and per-episode pickers share.
 */
export function VersionPicker(props: VersionPickerProps) {
  const { scope, movieId, seriesId, seasonNumber, episodeNumber, onClose } = props;
  const target = useMemo<ReleaseSearchTarget | undefined>(() => {
    if (scope === "movie") {
      return movieId === undefined ? undefined : { kind: "movie", movieId };
    }
    if (seriesId === undefined || seasonNumber === undefined) {
      return undefined;
    }
    return {
      kind: "series",
      seriesId,
      seasonNumber,
      ...(episodeNumber === undefined ? {} : { episodeNumber }),
    };
  }, [scope, movieId, seriesId, seasonNumber, episodeNumber]);

  if (!target) {
    return null;
  }

  return (
    <VersionPickerCard
      {...props}
      target={target}
      onClose={onClose}
    />
  );
}

function VersionPickerCard({
  target,
  title,
  subtitle,
  primaryLabel = "Download",
  footerExtra,
  onClose,
  onGrabbed,
}: VersionPickerProps & { target: ReleaseSearchTarget }) {
  const search = useReleaseSearch(target, { onGrabbed });
  const groups = search.groups;
  const data = search.data;
  const [selectedTier, setSelectedTier] = useState<number | null>(null);
  const [tierPinned, setTierPinned] = useState(false);
  const [alternativesOpen, setAlternativesOpen] = useState(false);
  const [showAllAlternatives, setShowAllAlternatives] = useState(false);
  const [attemptedReleaseId, setAttemptedReleaseId] = useState<string | null>(null);
  const clearGrabErrorRef = useRef<(() => void) | undefined>(undefined);
  clearGrabErrorRef.current = search.clearGrabError;

  useEffect(() => {
    if (groups.length === 0) {
      setSelectedTier(null);
      setTierPinned(false);
      return;
    }
    setSelectedTier((current) =>
      tierPinned && current !== null && groups.some((group) => group.tier === current)
        ? current
        : defaultTier(groups),
    );
  }, [groups, tierPinned]);

  // A different tier is a different set of releases, so drop the previous
  // inline failure and collapse the alternatives again.
  useEffect(() => {
    setAlternativesOpen(false);
    setShowAllAlternatives(false);
    setAttemptedReleaseId(null);
    clearGrabErrorRef.current?.();
  }, [selectedTier]);

  const selectedGroup = groups.find((group) => group.tier === selectedTier) ?? groups[0];
  const bestRelease = selectedGroup?.releases[0];
  const alternatives = selectedGroup?.releases.slice(1) ?? [];
  const visibleAlternatives = showAllAlternatives
    ? alternatives
    : alternatives.slice(0, ALTERNATIVE_PAGE_SIZE);

  const searching = data?.state === "searching" || data?.refreshing === true;
  const hasResults = groups.length > 0;
  const noResults = !searching && data?.state === "ready" && !hasResults;
  const allFailed = !searching && data?.state === "error" && !hasResults;
  const showSkeleton = (!data || (searching && !hasResults)) && !search.queryError;

  const download = (release: ShowRelease) => {
    setAttemptedReleaseId(release.id);
    search.grab(release);
  };
  const grabError = search.grabError;

  return (
    <Card className="min-w-0 gap-5.5 rounded-xl bg-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="font-heading text-xl font-semibold">
            {title ?? "Pick a version"}
          </h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            {subtitle ?? MOVIE_SUBTITLE}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {onClose ? (
            <Button variant="link" size="sm" onClick={onClose}>
              Close
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            className="h-10 px-3"
            onClick={search.refresh}
            disabled={search.refreshing}
          >
            <RefreshCwIcon
              data-icon="inline-start"
              className={search.refreshing ? "animate-spin" : undefined}
            />
            {search.refreshing ? "Searching…" : "Search again"}
          </Button>
        </div>
      </div>

      {search.queryError ? (
        <PickerMessage
          title="Couldn't load the cached releases."
          detail={search.queryError.message}
          tone="destructive"
        />
      ) : null}

      {showSkeleton ? <BestMatchSkeleton /> : null}

      {noResults ? (
        <PickerMessage
          title="No versions found."
          detail="Sources sometimes miss older or less common titles. Try again later."
        />
      ) : null}

      {allFailed ? (
        <PickerMessage
          title="Couldn't reach any sources."
          detail="Check that the torrent stack and VPN are running."
          tone="destructive"
        />
      ) : null}

      {hasResults ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <span className="text-xs text-muted-foreground">Quality</span>
            <ToggleGroup
              type="single"
              spacing={2}
              aria-label="Quality"
              value={selectedTier === null ? "" : String(selectedTier)}
              onValueChange={(value) => {
                if (!value) {
                  return;
                }
                setSelectedTier(Number(value));
                setTierPinned(true);
              }}
              className="flex-wrap justify-start gap-2"
            >
              {groups.map((group) => {
                const meta = RELEASE_TIER_META.find((entry) => entry.tier === group.tier);
                const selected = group.tier === selectedTier;
                return (
                  <ToggleGroupItem
                    key={group.tier}
                    value={String(group.tier)}
                    className={cn(
                      "h-14 min-w-30 flex-col items-start justify-center gap-0 rounded-lg border px-4 text-left whitespace-normal",
                      selected
                        ? "border-primary bg-secondary text-foreground"
                        : "border-secondary bg-transparent text-muted-foreground hover:bg-secondary/60",
                    )}
                  >
                    <span className="text-sm font-medium">{meta?.name ?? "Other"}</span>
                    <span className="text-xs text-muted-foreground">
                      {meta?.hint ?? "Unknown quality"}
                    </span>
                  </ToggleGroupItem>
                );
              })}
            </ToggleGroup>
          </div>

          {bestRelease ? (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-3 rounded-lg border border-primary/45 bg-secondary/60 p-4.5 sm:p-5">
                <div className="flex min-w-0 flex-[999_1_360px] flex-col gap-2">
                  <span className="text-xs font-semibold tracking-wide text-primary uppercase">
                    Best match
                  </span>
                  <ReleaseName release={bestRelease} className="text-base font-medium" />
                  <ReleaseMeta release={bestRelease} />
                </div>
                <Button
                  className="h-12 w-full px-5 sm:w-auto"
                  disabled={!bestRelease.canGrab || search.grabbing}
                  onClick={() => download(bestRelease)}
                >
                  {search.grabbingId === bestRelease.id ? (
                    <Loader2Icon data-icon="inline-start" className="animate-spin" />
                  ) : (
                    <DownloadIcon data-icon="inline-start" />
                  )}
                  {search.grabbingId === bestRelease.id ? "Starting…" : primaryLabel}
                </Button>
              </div>
              {grabError && attemptedReleaseId === bestRelease.id ? (
                <InlineGrabError />
              ) : null}
            </div>
          ) : null}

          {alternativesOpen && alternatives.length > 0 ? (
            <ul id="version-picker-alternatives" className="flex flex-col">
              {visibleAlternatives.map((release) => (
                <li key={release.id}>
                  <div className="flex flex-col gap-2 border-t border-border py-3.5 sm:flex-row sm:items-center sm:gap-4">
                    <div className="flex min-w-0 flex-[999_1_320px] flex-col">
                      <ReleaseName release={release} className="text-sm font-medium" />
                    </div>
                    <span className="text-sm text-muted-foreground sm:w-18">
                      {formatBytes(release.sizeBytes)}
                    </span>
                    <AvailabilityLabel
                      release={release}
                      className="text-sm sm:w-56"
                    />
                    <Button
                      variant="outline"
                      className="h-10 shrink-0 sm:ml-auto"
                      disabled={!release.canGrab || search.grabbing}
                      onClick={() => download(release)}
                    >
                      {search.grabbingId === release.id ? (
                        <Loader2Icon data-icon="inline-start" className="animate-spin" />
                      ) : (
                        <DownloadIcon data-icon="inline-start" />
                      )}
                      {search.grabbingId === release.id ? "Starting…" : primaryLabel}
                    </Button>
                  </div>
                  {grabError && attemptedReleaseId === release.id ? (
                    <InlineGrabError />
                  ) : null}
                </li>
              ))}
              {!showAllAlternatives && alternatives.length > ALTERNATIVE_PAGE_SIZE ? (
                <li>
                  <Button
                    variant="link"
                    size="sm"
                    className="w-fit px-0 underline"
                    onClick={() => setShowAllAlternatives(true)}
                  >
                    Show all {alternatives.length}
                  </Button>
                </li>
              ) : null}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-4">
          {alternatives.length === 0 ? (
            <span className="text-sm text-muted-foreground">
              No other versions at this quality
            </span>
          ) : (
            <Button
              variant="link"
              size="sm"
              className="h-auto px-0 text-sm underline"
              aria-expanded={alternativesOpen}
              aria-controls="version-picker-alternatives"
              onClick={() => setAlternativesOpen((open) => !open)}
            >
              {alternativesOpen
                ? "Show fewer"
                : `Show ${alternatives.length} more version${alternatives.length === 1 ? "" : "s"}`}
            </Button>
          )}
          {footerExtra}
        </div>
        <SearchStatus
          progress={data?.progress}
          fetchedAt={data?.fetchedAt}
          searching={searching}
          loaded={data !== undefined}
        />
      </div>
    </Card>
  );
}

function ReleaseName({
  release,
  className,
}: {
  release: ShowRelease;
  className?: string;
}) {
  return (
    <span
      className={cn("block min-w-0 truncate", className)}
      title={release.title}
    >
      {release.title}
    </span>
  );
}

function ReleaseMeta({ release }: { release: ShowRelease }) {
  const source = [release.indexer, release.ageHours !== undefined
    ? formatReleaseAge(release.ageHours)
    : undefined]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  return (
    <div className="flex flex-wrap items-center gap-x-4.5 gap-y-1 text-sm">
      <span className="text-foreground">{formatBytes(release.sizeBytes)}</span>
      <AvailabilityLabel release={release} />
      {source ? <span className="text-muted-foreground">{source}</span> : null}
    </div>
  );
}

function AvailabilityLabel({
  release,
  className,
}: {
  release: ShowRelease;
  className?: string;
}) {
  const availability = releaseAvailability(release.seeders);
  return (
    <span
      className={cn("inline-flex min-w-0 items-center gap-2", className)}
      title={availability.label}
    >
      <span
        aria-hidden="true"
        className={cn("size-2 shrink-0 rounded-full", availability.dotClassName)}
      />
      <span className={cn("min-w-0 truncate", availability.textClassName)}>
        {availability.label}
      </span>
    </span>
  );
}

function PickerMessage({
  title,
  detail,
  tone = "default",
}: {
  title: string;
  detail?: string;
  tone?: "default" | "destructive";
}) {
  return (
    <div className="flex flex-col gap-1 py-2">
      <p
        className={cn(
          "text-base font-medium",
          tone === "destructive" ? "text-destructive" : "text-foreground",
        )}
      >
        {title}
      </p>
      {detail ? (
        <p className="text-sm text-muted-foreground">{detail}</p>
      ) : null}
    </div>
  );
}

function InlineGrabError() {
  return (
    <p className="text-sm text-destructive" role="alert">
      Couldn&apos;t start that download. Try another version.
    </p>
  );
}

function BestMatchSkeleton() {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-secondary/40 p-4.5 sm:p-5">
      <div className="flex min-w-0 flex-[999_1_360px] flex-col gap-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-5 w-3/4 max-w-md" />
        <Skeleton className="h-4 w-2/3 max-w-sm" />
      </div>
      <Skeleton className="h-12 w-full sm:w-32" />
    </div>
  );
}

function SearchStatus({
  progress,
  fetchedAt,
  searching,
  loaded,
}: {
  progress: ReleaseSearchProgress | undefined;
  fetchedAt: string | undefined;
  searching: boolean;
  loaded: boolean;
}) {
  const finished = progress?.finished ?? 0;
  const sourceCount = progress?.total ?? 0;
  const text = !loaded
    ? "Searching…"
    : searching
      ? `Searching… ${finished} of ${sourceCount} sources`
      : `Searched ${finished} of ${sourceCount} sources${
          fetchedAt ? ` · ${formatRelativeAge(fetchedAt)}` : ""
        }`;

  return (
    <div
      className="flex min-w-0 flex-col items-end gap-1.5"
      aria-live="polite"
      aria-atomic="true"
    >
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="link" size="sm" className="h-auto px-0 text-xs text-muted-foreground">
            {text}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72">
          <PopoverHeader>
            <PopoverTitle>Sources</PopoverTitle>
            <PopoverDescription>
              {searching
                ? "Results stream in as each indexer finishes."
                : "Each indexer and how many releases it returned."}
            </PopoverDescription>
          </PopoverHeader>
          <ul className="flex flex-col gap-1.5">
            {(progress?.indexers ?? []).map((indexer) => (
              <li
                key={indexer.id}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <span className="min-w-0 truncate text-muted-foreground">
                  {indexer.name}
                </span>
                <IndexerState indexer={indexer} />
              </li>
            ))}
            {(progress?.indexers ?? []).length === 0 ? (
              <li className="text-sm text-muted-foreground">No sources reported yet.</li>
            ) : null}
          </ul>
        </PopoverContent>
      </Popover>
      {searching ? (
        <Progress
          value={sourceCount === 0 ? 0 : Math.round((finished / sourceCount) * 100)}
          className="h-1 w-40"
          aria-label="Search progress"
        />
      ) : null}
    </div>
  );
}

function IndexerState({ indexer }: { indexer: ReleaseIndexerProgress }) {
  if (indexer.state === "finished") {
    return (
      <span className="shrink-0 tabular-nums text-foreground">
        {indexer.count} {indexer.count === 1 ? "release" : "releases"}
      </span>
    );
  }
  if (indexer.state === "error") {
    return (
      <span className="shrink-0 text-destructive">
        {blockedDetail(indexer.detail)}
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-muted-foreground">
      <RotateCwIcon className="size-3 animate-spin" aria-hidden="true" />
      {indexer.state === "pending" ? "waiting" : "searching"}
    </span>
  );
}

/** Prowlarr reports a Cloudflare/legal block as HTTP 451; surface that. */
function blockedDetail(detail: string | undefined): string {
  if (detail && /\b451\b/.test(detail)) {
    return "blocked (451)";
  }
  return "failed";
}
