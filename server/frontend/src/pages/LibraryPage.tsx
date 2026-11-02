import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeftIcon, CircleAlertIcon, FilmIcon, SearchIcon } from "lucide-react";

import { fetchActivity, fetchLibrary, fetchRequestedLibrary } from "@/api/client";
import type {
  ActivityServiceState,
  ReleaseRepickEvent,
  RequestedLibraryServiceState,
} from "@/api/types";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LibraryGrid, LibraryGridSkeleton } from "@/features/library/LibraryGrid";
import { LibraryStateNotice } from "@/features/library/LibraryStateNotice";
import {
  mergeLibraryEntries,
  type LibraryEntry,
} from "@/features/library/library-entries";
import { useLibraryScanState } from "@/features/library/use-library-scan-state";

type Filter = "all" | "Movie" | "Series";

export function LibraryPage({ jellyfinUrl }: { jellyfinUrl?: string }) {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>("all");
  const [dismissedRepicks, setDismissedRepicks] = useState<number[]>([]);
  const [scanActive, setScanActive] = useState(false);
  const [activityActive, setActivityActive] = useState(false);
  const previousActivityKeys = useRef<Set<string>>(new Set());
  const libraryQuery = useQuery({
    queryKey: ["library"],
    queryFn: fetchLibrary,
    refetchInterval: scanActive ? 2_000 : 60_000,
  });
  const requestedQuery = useQuery({
    queryKey: ["requested-library"],
    queryFn: fetchRequestedLibrary,
    refetchInterval: activityActive ? 5_000 : 30_000,
  });
  const activityQuery = useQuery({
    queryKey: ["activity"],
    queryFn: fetchActivity,
    // 2×/s while something is downloading, slow back down once the queue is
    // empty. The backend caches each snapshot, so this is one upstream refresh
    // for every open tab rather than one per request.
    refetchInterval: (query) =>
      (query.state.data?.items.length ?? 0) > 0 ? 500 : 2_000,
  });

  const entries = useMemo(
    () =>
      mergeLibraryEntries(
        libraryQuery.data?.state === "ok" ? libraryQuery.data.items : [],
        requestedQuery.data?.items ?? [],
        activityQuery.data?.items ?? [],
      ),
    [activityQuery.data, libraryQuery.data, requestedQuery.data],
  );
  const displayEntries = useLibraryScanState(entries);
  const filtered = useMemo(
    () =>
      filter === "all"
        ? displayEntries
        : displayEntries.filter((entry) => entry.type === filter),
    [displayEntries, filter],
  );
  const activeCount = displayEntries.filter((entry) => entry.activity).length;
  const loading =
    (libraryQuery.isLoading || requestedQuery.isLoading || activityQuery.isLoading) &&
    displayEntries.length === 0;

  useEffect(() => {
    setScanActive(displayEntries.some((entry) => entry.status === "scanning"));
  }, [displayEntries]);

  useEffect(() => {
    setActivityActive((activityQuery.data?.items.length ?? 0) > 0);
  }, [activityQuery.data]);

  useEffect(() => {
    const nextKeys = new Set(
      activityQuery.data?.items.map((item) => item.key) ?? [],
    );
    const shrank = [...previousActivityKeys.current].some(
      (key) => !nextKeys.has(key),
    );
    previousActivityKeys.current = nextKeys;
    if (shrank) {
      void queryClient.invalidateQueries({ queryKey: ["requested-library"] });
    }
  }, [activityQuery.data, queryClient]);
  const activityNotices = activityQuery.data?.services.filter(
    (service) => service.state !== "ok" || service.detail,
  );
  const requestedNotices = requestedQuery.data?.services.filter(
    (service) =>
      service.state !== "ok" &&
      service.state !== "unconfigured" &&
      !activityNotices?.some((activityService) => activityService.id === service.id),
  );
  const libraryOk = libraryQuery.data?.state === "ok";
  const activitySettled =
    activityQuery.data?.services.every((service) => service.state === "ok") ?? false;
  const requestedSettled =
    requestedQuery.data?.services.every((service) => service.state === "ok") ?? false;
  const repicks = (activityQuery.data?.repicks ?? []).filter(
    (event) => !dismissedRepicks.includes(event.id),
  );

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-heading text-xl font-semibold tracking-tight">Library</h2>
          {displayEntries.length > 0 ? (
            <span className="text-sm text-muted-foreground">
              {displayEntries.length} {displayEntries.length === 1 ? "title" : "titles"}
            </span>
          ) : null}
          {activeCount > 0 ? (
            <span className="text-sm text-muted-foreground">
              · {activeCount} active {activeCount === 1 ? "download" : "downloads"}
            </span>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">
          Movies and shows in Jellyfin, requested titles, plus downloads in progress.
        </p>
      </div>

      {libraryQuery.error && !libraryQuery.data ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Could not load the Jellyfin library</AlertTitle>
          <AlertDescription>{libraryQuery.error.message}</AlertDescription>
        </Alert>
      ) : null}
      {requestedQuery.error && !requestedQuery.data ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Could not load requested titles</AlertTitle>
          <AlertDescription>{requestedQuery.error.message}</AlertDescription>
        </Alert>
      ) : null}
      {activityQuery.error && !activityQuery.data ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Could not load active downloads</AlertTitle>
          <AlertDescription>{activityQuery.error.message}</AlertDescription>
        </Alert>
      ) : null}

      {requestedNotices?.map((service) => (
        <RequestedServiceNotice key={service.id} service={service} />
      ))}
      {activityNotices?.map((service) => (
        <ActivityServiceNotice key={service.id} service={service} />
      ))}

      {repicks.length > 0 ? (
        <RepickNotice
          events={repicks}
          onDismiss={(id) => setDismissedRepicks((current) => [...current, id])}
        />
      ) : null}

      {libraryQuery.data && libraryQuery.data.state !== "ok" ? (
        <LibraryStateNotice library={libraryQuery.data} jellyfinUrl={jellyfinUrl} />
      ) : null}

      {loading ? <LibraryGridSkeleton /> : null}

      {!loading && displayEntries.length > 0 ? (
        <Tabs value={filter} onValueChange={(value) => setLibraryFilter(value, setFilter)}>
          <TabsList>
            <TabsTrigger value="all">All ({displayEntries.length})</TabsTrigger>
            <TabsTrigger value="Movie">{`Movies (${countType(displayEntries, "Movie")})`}</TabsTrigger>
            <TabsTrigger value="Series">{`Series (${countType(displayEntries, "Series")})`}</TabsTrigger>
          </TabsList>
          <TabsContent value={filter}>
            {filtered.length > 0 ? (
              <LibraryGrid entries={filtered} />
            ) : (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <FilmIcon />
                  </EmptyMedia>
                  <EmptyTitle>Nothing here yet</EmptyTitle>
                  <EmptyDescription>
                    No {filter === "Movie" ? "movies" : "series"} match this view.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </TabsContent>
        </Tabs>
      ) : null}

      {!loading &&
      displayEntries.length === 0 &&
      libraryOk &&
      activityQuery.data &&
      activitySettled &&
      requestedSettled ? (
        <EmptyLibrary />
      ) : null}
    </section>
  );
}

function RepickNotice({
  events,
  onDismiss,
}: {
  events: ReleaseRepickEvent[];
  onDismiss: (id: number) => void;
}) {
  const shown = events.slice(0, 3);
  return (
    <Alert>
      <ArrowRightLeftIcon />
      <AlertTitle>Release re-picked for a faster swarm</AlertTitle>
      <AlertDescription>
        <ul className="flex flex-col gap-2">
          {shown.map((event) => (
            <li key={event.id} className="flex flex-col gap-1">
              <span>
                <span className="font-medium text-foreground">{event.mediaTitle}</span>
                {event.seasonNumber !== undefined
                  ? ` · season ${event.seasonNumber}`
                  : ""}
                {" — "}
                only {event.connectedSeeds ?? "a few"} connected seed
                {event.connectedSeeds === 1 ? "" : "s"}
                {event.downloadSpeed !== undefined
                  ? ` at ${formatSpeed(event.downloadSpeed)}`
                  : ""}
                . Switched from{" "}
                <span title={event.fromTitle}>{shortRelease(event.fromTitle)}</span>{" "}
                to{" "}
                <span title={event.toTitle}>{shortRelease(event.toTitle)}</span>
                {event.toReportedSeeders !== undefined
                  ? ` (${event.toReportedSeeders} reported seeders)`
                  : ""}
                .
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="w-fit"
                onClick={() => onDismiss(event.id)}
              >
                Dismiss
              </Button>
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

function shortRelease(title: string): string {
  return title.length > 56 ? `${title.slice(0, 53)}…` : title;
}

function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond >= 1024 * 1024) {
    return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
  }
  return `${Math.max(0, Math.round(bytesPerSecond / 1024))} KB/s`;
}

function RequestedServiceNotice({ service }: { service: RequestedLibraryServiceState }) {
  const name = service.id === "sonarr" ? "Sonarr" : "Radarr";
  return (
    <Alert variant="destructive">
      <CircleAlertIcon />
      <AlertTitle>{name} requested titles are unavailable</AlertTitle>
      <AlertDescription>
        {service.detail ?? `Check that ${name} is running and its API key is configured.`}
      </AlertDescription>
    </Alert>
  );
}

function ActivityServiceNotice({ service }: { service: ActivityServiceState }) {
  const name = service.id === "sonarr" ? "Sonarr" : "Radarr";
  return (
    <Alert variant={service.state === "unconfigured" ? "default" : "destructive"}>
      <CircleAlertIcon />
      <AlertTitle>
        {service.state === "ok" ? `${name} download details are limited` : `${name} downloads are unavailable`}
      </AlertTitle>
      <AlertDescription>
        {service.detail ?? `Check that ${name} is running and its API key is configured.`}
      </AlertDescription>
    </Alert>
  );
}

function EmptyLibrary() {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FilmIcon />
        </EmptyMedia>
        <EmptyTitle>Nothing in the library yet</EmptyTitle>
        <EmptyDescription>
          Request a movie or show from Search, or add media under <code>/data/media</code> and
          scan it in Jellyfin.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild variant="outline" size="sm">
          <a href="#/search">
            <SearchIcon data-icon="inline-start" />
            Search for something to watch
          </a>
        </Button>
      </EmptyContent>
    </Empty>
  );
}

function countType(entries: LibraryEntry[], type: LibraryEntry["type"]): number {
  return entries.filter((entry) => entry.type === type).length;
}

function setLibraryFilter(value: string, setFilter: (value: Filter) => void): void {
  if (value === "all" || value === "Movie" || value === "Series") {
    setFilter(value);
  }
}
