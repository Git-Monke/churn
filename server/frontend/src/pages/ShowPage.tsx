import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronLeftIcon,
  CircleAlertIcon,
  DownloadIcon,
  FilmIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { fetchShow, fetchShowDownloads } from "@/api/client";
import type { ShowDetailResponse, ShowEpisode } from "@/api/types";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { VersionPicker } from "@/features/releases/VersionPicker";
import { CancelEpisodeDownloadDialog } from "@/features/show/CancelEpisodeDownloadDialog";
import { EpisodeList, EpisodeRow } from "@/features/show/EpisodeRow";
import { resumeTarget } from "@/features/show/episode-watch-state";
import { ReleasePickerDialog } from "@/features/show/ReleasePickerDialog";
import { SeasonTabs } from "@/features/show/SeasonTabs";
import { DeleteTitleDialog } from "@/features/title/DeleteTitleDialog";
import { TitleHeader } from "@/features/title/TitleHeader";
import { TitleMenu, type TitleMenuItem } from "@/features/title/TitleMenu";
import {
  TitlePrimaryAction,
  type TitleAction,
} from "@/features/title/TitlePrimaryAction";
import { useTitleAttribution } from "@/features/title/use-title-attribution";
import { playHash, replaceHash, showHash, type ShowSource } from "@/hooks/use-hash-route";

export function ShowPage({
  source,
  id,
  season,
}: {
  source: ShowSource;
  id: string;
  season?: number;
}) {
  const showQuery = useQuery({
    queryKey: ["show", source, id],
    queryFn: () => fetchShow(source, id),
    // While Jellyfin is re-indexing an empty show, poll fast enough to pick up
    // the episodes as soon as the scan finishes.
    refetchInterval: (query) => (query.state.data?.scanning ? 2_000 : 10_000),
  });
  // The lean download endpoint only reads qBittorrent and a cached show/episode
  // identity. Poll it twice per second while any episode is downloading.
  const showDownloadQuery = useQuery({
    queryKey: ["show", source, id, "downloads"],
    queryFn: () => fetchShowDownloads(source, id),
    refetchInterval: (query) => {
      const live = query.state.data;
      return live?.ready === true && Object.keys(live.downloads).length > 0
        ? 500
        : 2_000;
    },
  });
  const liveDownloads = showDownloadQuery.data?.ready
    ? showDownloadQuery.data.downloads
    : undefined;
  const [selectedSeason, setSelectedSeason] = useState<number | null>(null);
  const [releaseEpisode, setReleaseEpisode] = useState<ShowEpisode | null>(null);
  const [cancelEpisode, setCancelEpisode] = useState<ShowEpisode | null>(null);
  /** Off by default: the season picker grabs a whole season pack at once. */
  const [pickEpisodes, setPickEpisodes] = useState(false);
  /** The season picker, opened from the banner for a partially downloaded season. */
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    const data = showQuery.data;
    if (!data || data.seasons.length === 0) {
      setSelectedSeason(null);
      return;
    }
    setSelectedSeason((current) => {
      const preferred = season ?? current;
      if (
        preferred !== null &&
        data.seasons.some((entry) => entry.seasonNumber === preferred)
      ) {
        return preferred;
      }
      return data.defaultSeason ?? data.seasons[0]?.seasonNumber ?? null;
    });
  }, [showQuery.data, season]);

  const episodes = useMemo(() => {
    if (!showQuery.data || selectedSeason === null) {
      return [];
    }
    const seasonEpisodes = showQuery.data.episodes.filter(
      (episode) => episode.seasonNumber === selectedSeason,
    );
    if (!liveDownloads) {
      return seasonEpisodes;
    }
    return seasonEpisodes.map((episode) => {
      const download = liveDownloads[episode.key];
      const next: ShowEpisode = { ...episode };
      if (download) {
        next.download = download;
      } else {
        delete next.download;
      }
      return next;
    });
  }, [selectedSeason, showQuery.data, liveDownloads]);

  // A different season is a different list: reset the local view state.
  useEffect(() => {
    setPickEpisodes(false);
    setPickerOpen(false);
  }, [selectedSeason]);

  // Jellyfin-backed shows still expose their Sonarr series id, so release
  // searches and episode cancels work from the same page.
  const sonarrSeriesId = showQuery.data?.sonarrId;
  const seasonDownloadActive = episodes.some(
    (episode) =>
      episode.download !== undefined && episode.download.status !== "warning",
  );
  const seasonHasFile = episodes.some(
    (episode) => episode.availability === "jellyfin" || episode.imported,
  );
  const missingEpisodes = episodes.filter(
    (episode) => episode.availability === "missing" && !episode.imported,
  );
  // A season with nothing at all opens on its download card; a season that is
  // only partially there keeps a quieter banner until asked.
  const seasonMissing = episodes.length > 0 && missingEpisodes.length === episodes.length;
  const canPickSeason =
    sonarrSeriesId !== undefined &&
    selectedSeason !== null &&
    !seasonDownloadActive &&
    !pickEpisodes &&
    missingEpisodes.length > 0;
  const showSeasonPicker = canPickSeason && (seasonMissing || pickerOpen);
  const showMissingBanner = canPickSeason && !seasonMissing && !pickerOpen;

  return (
    <div className="flex flex-col gap-8">
      {/* The header owns the back link once the show is loaded. */}
      {showQuery.data?.state === "ok" ? null : (
        <a
          href="#/library"
          className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeftIcon className="size-4" />
          Back to Library
        </a>
      )}

      {showQuery.isLoading ? <ShowPageSkeleton /> : null}

      {showQuery.error && !showQuery.data ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Could not load this show</AlertTitle>
          <AlertDescription>{showQuery.error.message}</AlertDescription>
        </Alert>
      ) : null}

      {showQuery.data && showQuery.data.state !== "ok" ? (
        <ShowStateNotice show={showQuery.data} />
      ) : null}

      {showQuery.data?.state === "ok" ? (
        <>
          <ShowHeader data={showQuery.data} source={source} id={id} />

          {showQuery.data.warnings?.map((warning) => (
            <Alert key={warning}>
              <TriangleAlertIcon />
              <AlertTitle>Download status is limited</AlertTitle>
              <AlertDescription>{warning}</AlertDescription>
            </Alert>
          ))}

          {showQuery.data.seasons.length > 0 ? (
            <section className="flex flex-col gap-5">

              <SeasonTabs
                seasons={showQuery.data.seasons}
                selected={selectedSeason}
                onSelect={(next) => {
                  setSelectedSeason(next);
                  // Keep the season in the URL so the player can return to it.
                  replaceHash(showHash(source, id, next));
                }}
              />

              {showSeasonPicker && selectedSeason !== null ? (
                <div className="mt-1">
                  <VersionPicker
                    key={`${sonarrSeriesId}:${selectedSeason}`}
                    scope="season"
                    seriesId={sonarrSeriesId}
                    seasonNumber={selectedSeason}
                    title={
                      seasonHasFile
                        ? `${missingEpisodes.length} ${
                            missingEpisodes.length === 1 ? "episode is" : "episodes are"
                          } still missing`
                        : `${seasonName(selectedSeason)} isn’t downloaded yet`
                    }
                    subtitle={
                      seasonHasFile
                        ? "Pick a version to fill in the missing episodes, or grab them one at a time."
                        : `Pick a quality and all ${episodes.length} ${
                            episodes.length === 1 ? "episode" : "episodes"
                          } will download together.`
                    }
                    primaryLabel="Download season"
                    footerExtra={
                      <Button
                        variant="link"
                        size="sm"
                        className="h-auto px-0 text-sm underline"
                        onClick={() => setPickEpisodes(true)}
                      >
                        Pick episodes one at a time
                      </Button>
                    }
                    onGrabbed={() => void showQuery.refetch()}
                  />
                </div>
              ) : null}

              {showMissingBanner ? (
                <div className="flex flex-wrap items-center gap-4 rounded-xl bg-card px-4.5 py-3.5">
                  <p className="flex-1 text-sm text-foreground">
                    {missingEpisodes.length} {missingEpisodes.length === 1 ? "episode" : "episodes"}{" "}
                    in this season {missingEpisodes.length === 1 ? "isn't" : "aren't"} downloaded yet.
                  </p>
                  <Button
                    variant="outline"
                    className="h-10 shrink-0 border-primary px-4 text-sm font-medium"
                    onClick={() => setPickerOpen(true)}
                  >
                    Get missing episodes
                  </Button>
                </div>
              ) : null}

              {pickEpisodes && missingEpisodes.length > 0 ? (
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
                  <span>Picking episodes one at a time.</span>
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto px-0 text-sm underline"
                    onClick={() => {
                      setPickEpisodes(false);
                      setPickerOpen(true);
                    }}
                  >
                    Download the whole season instead
                  </Button>
                </div>
              ) : null}

              <ReleasePickerDialog
                open={releaseEpisode !== null}
                onOpenChange={(open) => {
                  if (!open) {
                    setReleaseEpisode(null);
                  }
                }}
                seriesId={sonarrSeriesId}
                seasonNumber={releaseEpisode?.seasonNumber}
                episodeNumber={releaseEpisode?.episodeNumber}
                showTitle={showQuery.data.series.title}
              />

              <CancelEpisodeDownloadDialog
                open={cancelEpisode !== null}
                onOpenChange={(open) => {
                  if (!open) {
                    setCancelEpisode(null);
                  }
                }}
                seriesId={sonarrSeriesId ?? 0}
                seasonNumber={cancelEpisode?.seasonNumber ?? 0}
                episodeNumber={cancelEpisode?.episodeNumber ?? 0}
                episodeTitle={
                  cancelEpisode
                    ? `${episodeCode(cancelEpisode)} · ${cancelEpisode.title}`
                    : "This episode"
                }
                seasonPack={cancelEpisode?.download?.seasonPack === true}
              />

              {episodes.length > 0 ? (
                <EpisodeList>
                  {episodes.map((episode) => (
                    <EpisodeRow
                      key={episode.key}
                      episode={episode}
                      compact={!seasonHasFile}
                      playHref={
                          episode.jellyfinId && episode.availability === "jellyfin"
                            ? playHash(episode.jellyfinId, {
                                source,
                                id,
                                season: selectedSeason ?? undefined,
                              })
                            : undefined
                        }
                        onChooseRelease={
                          pickEpisodes &&
                          sonarrSeriesId !== undefined &&
                          episode.download === undefined &&
                          episode.availability === "missing" &&
                          !episode.imported
                            ? () => setReleaseEpisode(episode)
                            : undefined
                        }
                        onCancelDownload={
                          sonarrSeriesId !== undefined &&
                          episode.download !== undefined
                            ? () => setCancelEpisode(episode)
                            : undefined
                        }
                      />
                    ))}
                </EpisodeList>
              ) : (
                <Empty className="border">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <FilmIcon />
                    </EmptyMedia>
                    <EmptyTitle>No episodes in this season</EmptyTitle>
                    <EmptyDescription>
                      Try another season or check Sonarr for this show.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </section>
          ) : showQuery.data.source === "jellyfin" ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FilmIcon />
                </EmptyMedia>
                <EmptyTitle>Jellyfin is still indexing this show</EmptyTitle>
                <EmptyDescription>
                  {showQuery.data.scanning
                    ? "Jellyfin knows about this show but has not added its episodes yet. A library scan was requested; this page checks again automatically."
                    : "Jellyfin knows about this show but has not added its episodes yet. Refresh the Jellyfin library and try again."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FilmIcon />
                </EmptyMedia>
                <EmptyTitle>No episodes found</EmptyTitle>
                <EmptyDescription>
                  This show has no episodes in Jellyfin or Sonarr yet.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </>
      ) : null}
    </div>
  );
}

/**
 * Poster, title and the one primary action for a show. Playback resumes where
 * this user left off: the episode in progress, otherwise the first unwatched
 * episode, otherwise the first playable one.
 */
function ShowHeader({
  data,
  source,
  id,
}: {
  data: ShowDetailResponse;
  source: ShowSource;
  id: string;
}) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const { series, episodes, seasons, sonarrId } = data;
  const playable = episodes.some((episode) => episode.availability === "jellyfin");
  const jellyfinId = source === "jellyfin" ? id : undefined;
  const regularSeasons = seasons.filter((season) => season.seasonNumber !== 0);
  const addedBy = useTitleAttribution(
    {
      kind: "series",
      ...(series.tvdbId === undefined ? {} : { tvdbId: series.tvdbId }),
      ...(series.tmdbId === undefined ? {} : { tmdbId: series.tmdbId }),
      title: series.title,
      ...(series.year === undefined ? {} : { year: series.year }),
    },
    playable,
  );

  const episode = resumeTarget(episodes);
  const action: TitleAction =
    episode?.jellyfinId === undefined
      ? { kind: "not-downloaded" }
      : {
          kind: "play",
          href: playHash(episode.jellyfinId, {
            source,
            id,
            season: episode.seasonNumber,
          }),
          label: `Play S${episode.seasonNumber} · E${episode.episodeNumber}`,
        };

  const menuItems: TitleMenuItem[] = [
    {
      label: "Delete from library",
      destructive: true,
      onSelect: () => setDeleteOpen(true),
    },
  ];

  return (
    <>
      <TitleHeader
        poster={{ imageUrl: series.imageUrl, alt: `${series.title} poster` }}
        title={series.title}
        metadata={[
          series.year === undefined ? undefined : String(series.year),
          series.network,
          regularSeasons.length === 0
            ? undefined
            : `${regularSeasons.length} ${regularSeasons.length === 1 ? "season" : "seasons"}`,
          series.rating === undefined ? undefined : `${series.rating.toFixed(1)} / 10`,
        ]}
        synopsis={series.overview}
        dimmed={!playable}
        action={<TitlePrimaryAction action={action} />}
        menu={<TitleMenu items={menuItems} />}
        attribution={
          addedBy ? `${playable ? "Added" : "Requested"} by ${addedBy.name}` : undefined
        }
      />
      <DeleteTitleDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={series.title}
        jellyfinId={jellyfinId}
        arrService={sonarrId === undefined ? undefined : "sonarr"}
        arrId={sonarrId}
        onDeleted={() => {
          window.location.hash = "#/library";
        }}
      />
    </>
  );
}

function ShowStateNotice({ show }: { show: ShowDetailResponse }) {
  const name = show.source === "jellyfin" ? "Jellyfin" : "Sonarr";
  return (
    <Alert variant={show.state === "unconfigured" || show.state === "unauthorized" ? "default" : "destructive"}>
      <CircleAlertIcon />
      <AlertTitle>{name} is not ready</AlertTitle>
      <AlertDescription>
        {show.detail ?? `Check that ${name} is running and its API key is configured.`}
      </AlertDescription>
      <AlertAction>
        <Button asChild variant="outline" size="sm">
          <a
            href={`/api/services/${show.source === "jellyfin" ? "jellyfin" : "sonarr"}/open`}
            target="_blank"
            rel="noreferrer"
          >
            Open {name}
          </a>
        </Button>
      </AlertAction>
    </Alert>
  );
}

function ShowPageSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end gap-x-10 gap-y-6">
        <Skeleton className="aspect-[2/3] w-35 shrink-0 rounded-lg sm:w-55" />
        <div className="flex min-w-0 flex-[999_1_480px] flex-col gap-4.5">
          <Skeleton className="h-3.5 w-20" />
          <Skeleton className="h-10 w-2/3 max-w-md" />
          <Skeleton className="h-4 w-64" />
          <Skeleton className="h-4 w-full max-w-xl" />
          <Skeleton className="h-4 w-4/5 max-w-lg" />
          <Skeleton className="h-12 w-32" />
        </div>
      </div>
      <div className="flex flex-col gap-3">
        {Array.from({ length: 5 }).map((_, index) => (
          <Skeleton key={index} className="h-20 rounded-xl" />
        ))}
      </div>
    </div>
  );
}

function seasonName(seasonNumber: number): string {
  return seasonNumber === 0 ? "Specials" : `Season ${seasonNumber}`;
}

function episodeCode(episode: ShowEpisode): string {
  return `S${String(episode.seasonNumber).padStart(2, "0")}E${String(episode.episodeNumber).padStart(2, "0")}`;
}
