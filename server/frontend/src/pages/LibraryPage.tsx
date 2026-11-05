import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRightLeftIcon,
  CircleAlertIcon,
  FilmIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";

import { fetchActivity, fetchLibrary, fetchRequestedLibrary } from "@/api/client";
import type {
  ActivityServiceState,
  LibraryResponse,
  ReleaseRepickEvent,
  RequestedLibraryServiceState,
} from "@/api/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useAuth } from "@/features/auth/AuthProvider";
import { ContinueWatching } from "@/features/library/ContinueWatching";
import { LibraryGrid, LibraryGridSkeleton } from "@/features/library/LibraryGrid";
import { OnTheWay } from "@/features/library/OnTheWay";
import { searchLibraryEntries } from "@/features/library/library-search";
import { LibraryStateNotice } from "@/features/library/LibraryStateNotice";
import { mergeLibraryEntries } from "@/features/library/library-entries";
import { useLibraryScanState } from "@/features/library/use-library-scan-state";
import { cn } from "@/lib/utils";

type Filter = "all" | "Movie" | "Series";

export function LibraryPage({ jellyfinUrl }: { jellyfinUrl?: string }) {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const currentUserId = session?.user?.id;
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [addedByMe, setAddedByMe] = useState(false);
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
  // Shows always live in the grid, even before anything is playable: their page
  // is where seasons and releases get picked. Movies only join the grid once
  // Jellyfin has them; until then they are "On the way".
  const browseable = useMemo(
    () =>
      displayEntries.filter(
        (entry) => entry.library !== undefined || entry.type === "Series",
      ),
    [displayEntries],
  );
  const onTheWay = useMemo(
    () =>
      displayEntries.filter(
        (entry) => entry.activity !== undefined || !browseable.includes(entry),
      ),
    [browseable, displayEntries],
  );
  const searched = useMemo(
    () => searchLibraryEntries(browseable, query),
    [browseable, query],
  );
  const mineActive = addedByMe && currentUserId !== undefined;
  const scoped = useMemo(
    () =>
      mineActive
        ? searched.filter((entry) => entry.addedBy?.id === currentUserId)
        : searched,
    [currentUserId, mineActive, searched],
  );
  const filtered = useMemo(
    () =>
      filter === "all"
        ? scoped
        : scoped.filter((entry) => entry.type === filter),
    [filter, scoped],
  );
  const searching = query.trim().length > 0;
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
    (service) => service.state !== "ok" && service.state !== "unconfigured",
  );
  const activitySettled =
    activityQuery.data?.services.every((service) => service.state === "ok") ?? false;
  const requestedSettled =
    requestedQuery.data?.services.every((service) => service.state === "ok") ?? false;
  const repicks = (activityQuery.data?.repicks ?? []).filter(
    (event) => !dismissedRepicks.includes(event.id),
  );

  return (
    <div className="flex flex-col [&>*+*]:mt-10 [&>*+*]:border-t [&>*+*]:border-border [&>*+*]:pt-10">
      <Alerts
        libraryState={libraryQuery.data}
        libraryError={libraryQuery.error}
        requestedError={requestedQuery.error}
        activityError={activityQuery.error}
        requestedNotices={requestedNotices}
        activityNotices={activityNotices}
        repicks={repicks}
        jellyfinUrl={jellyfinUrl}
        onDismissRepick={(id) =>
          setDismissedRepicks((current) => [...current, id])
        }
      />

      <ContinueWatching />

      <OnTheWay entries={onTheWay} />

      <section aria-labelledby="library-heading" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <div className="flex items-baseline gap-2">
            <h2
              id="library-heading"
              className="font-heading text-xl font-semibold tracking-tight"
            >
              Library
            </h2>
            <span className="text-sm text-muted-foreground">
              {filtered.length} {filtered.length === 1 ? "title" : "titles"}
            </span>
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-3">
            <ToggleGroup
              type="single"
              value={filter}
              onValueChange={(value) => setLibraryFilter(value, setFilter)}
              aria-label="Filter the library"
              className="gap-1 bg-card p-1"
            >
              {FILTERS.map((option) => (
                <ToggleGroupItem
                  key={option.value}
                  value={option.value}
                  className={cn(
                    "text-muted-foreground",
                    filter === option.value && "bg-secondary text-foreground",
                  )}
                >
                  {option.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>

            {currentUserId ? (
              <Toggle
                variant="outline"
                pressed={mineActive}
                onPressedChange={setAddedByMe}
                className={cn(mineActive && "border-primary")}
              >
                Added by me
              </Toggle>
            ) : null}

            {browseable.length > 0 ? (
              <InputGroup className="w-full bg-card sm:w-65">
                <InputGroupAddon>
                  <SearchIcon />
                </InputGroupAddon>
                <InputGroupInput
                  type="search"
                  value={query}
                  aria-label="Search library"
                  placeholder="Search library"
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      setQuery("");
                    }
                  }}
                />
                {query ? (
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      size="icon-xs"
                      aria-label="Clear search"
                      onClick={() => setQuery("")}
                    >
                      <XIcon />
                    </InputGroupButton>
                  </InputGroupAddon>
                ) : null}
              </InputGroup>
            ) : null}
          </div>
        </div>

        {loading ? <LibraryGridSkeleton /> : null}

        {!loading && filtered.length > 0 ? (
          <LibraryGrid entries={filtered} />
        ) : null}

        {!loading && filtered.length === 0 && browseable.length > 0 ? (
          <NoMatches
            query={searching ? query.trim() : undefined}
            mine={mineActive}
            filter={filter}
            onClearSearch={() => setQuery("")}
            onShowEveryone={() => setAddedByMe(false)}
          />
        ) : null}

        {!loading &&
        browseable.length === 0 &&
        activityQuery.data &&
        activitySettled &&
        requestedSettled ? (
          <EmptyLibrary />
        ) : null}
      </section>
    </div>
  );
}

const FILTERS = [
  { value: "all", label: "All" },
  { value: "Movie", label: "Movies" },
  { value: "Series", label: "Shows" },
] as const;

function Alerts({
  libraryState,
  libraryError,
  requestedError,
  activityError,
  requestedNotices,
  activityNotices,
  repicks,
  jellyfinUrl,
  onDismissRepick,
}: {
  libraryState?: LibraryResponse;
  libraryError: Error | null;
  requestedError: Error | null;
  activityError: Error | null;
  requestedNotices: RequestedLibraryServiceState[] | undefined;
  activityNotices: ActivityServiceState[] | undefined;
  repicks: ReleaseRepickEvent[];
  jellyfinUrl?: string;
  onDismissRepick: (id: number) => void;
}) {
  const hasLibraryError = Boolean(libraryError && !libraryState);
  const hasRequestedError = Boolean(requestedError);
  const hasActivityError = Boolean(activityError);
  const showLibraryState = Boolean(libraryState && libraryState.state !== "ok");

  if (
    !hasLibraryError &&
    !hasRequestedError &&
    !hasActivityError &&
    !showLibraryState &&
    !requestedNotices?.length &&
    !activityNotices?.length &&
    repicks.length === 0
  ) {
    return null;
  }

  return (
    <div className="flex flex-col gap-3">
      {hasLibraryError ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Could not load the Jellyfin library</AlertTitle>
          <AlertDescription>{libraryError?.message}</AlertDescription>
        </Alert>
      ) : null}
      {hasRequestedError ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Could not load requested titles</AlertTitle>
          <AlertDescription>{requestedError?.message}</AlertDescription>
        </Alert>
      ) : null}
      {hasActivityError ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Could not load active downloads</AlertTitle>
          <AlertDescription>{activityError?.message}</AlertDescription>
        </Alert>
      ) : null}
      {requestedNotices?.map((service) => (
        <RequestedServiceNotice key={service.id} service={service} />
      ))}
      {activityNotices?.map((service) => (
        <ActivityServiceNotice key={service.id} service={service} />
      ))}
      {repicks.length > 0 ? (
        <RepickNotice events={repicks} onDismiss={onDismissRepick} />
      ) : null}
      {showLibraryState && libraryState ? (
        <LibraryStateNotice library={libraryState} jellyfinUrl={jellyfinUrl} />
      ) : null}
    </div>
  );
}

function NoMatches({
  query,
  mine,
  filter,
  onClearSearch,
  onShowEveryone,
}: {
  query?: string;
  mine: boolean;
  filter: Filter;
  onClearSearch: () => void;
  onShowEveryone: () => void;
}) {
  const typeLabel = filter === "Movie" ? "movies" : filter === "Series" ? "shows" : "titles";
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FilmIcon />
        </EmptyMedia>
        <EmptyTitle>
          {query ? `No matches for “${query}”` : mine ? "Nothing added by you" : "Nothing here yet"}
        </EmptyTitle>
        <EmptyDescription>
          {query
            ? `No ${typeLabel} match your search${mine ? " in your additions" : ""}.`
            : mine
              ? "Nothing in this view was added by you."
              : `No ${typeLabel} match this view.`}
        </EmptyDescription>
      </EmptyHeader>
      {query ? (
        <EmptyContent>
          <Button variant="outline" size="sm" onClick={onClearSearch}>
            Clear search
          </Button>
        </EmptyContent>
      ) : mine ? (
        <EmptyContent>
          <Button variant="outline" size="sm" onClick={onShowEveryone}>
            Show everyone&apos;s library
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
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
  const name = "qBittorrent";
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
          Request a movie or show from Find something new, or add media under{" "}
          <code>/data/media</code> and scan it in Jellyfin.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild variant="outline" size="sm">
          <a href="#/search">
            <SearchIcon data-icon="inline-start" />
            Find something new
          </a>
        </Button>
      </EmptyContent>
    </Empty>
  );
}

function setLibraryFilter(value: string, setFilter: (value: Filter) => void): void {
  if (value === "all" || value === "Movie" || value === "Series") {
    setFilter(value);
  }
}
