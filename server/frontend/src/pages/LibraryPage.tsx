import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CircleAlertIcon, FilmIcon, SearchIcon } from "lucide-react";

import { fetchActivity, fetchLibrary } from "@/api/client";
import type { ActivityServiceState } from "@/api/types";
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

type Filter = "all" | "Movie" | "Series";

export function LibraryPage({ jellyfinUrl }: { jellyfinUrl?: string }) {
  const [filter, setFilter] = useState<Filter>("all");
  const libraryQuery = useQuery({
    queryKey: ["library"],
    queryFn: fetchLibrary,
    refetchInterval: 60_000,
  });
  const activityQuery = useQuery({
    queryKey: ["activity"],
    queryFn: fetchActivity,
    refetchInterval: 10_000,
  });

  const entries = useMemo(
    () =>
      mergeLibraryEntries(
        libraryQuery.data?.state === "ok" ? libraryQuery.data.items : [],
        activityQuery.data?.items ?? [],
      ),
    [activityQuery.data, libraryQuery.data],
  );
  const filtered = useMemo(
    () => (filter === "all" ? entries : entries.filter((entry) => entry.type === filter)),
    [entries, filter],
  );
  const activeCount = entries.filter((entry) => entry.activity).length;
  const loading = (libraryQuery.isLoading || activityQuery.isLoading) && entries.length === 0;
  const activityNotices = activityQuery.data?.services.filter(
    (service) => service.state !== "ok" || service.detail,
  );
  const libraryOk = libraryQuery.data?.state === "ok";
  const activitySettled =
    activityQuery.data?.services.every((service) => service.state === "ok") ?? false;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-heading text-xl font-semibold tracking-tight">Library</h2>
          {libraryOk ? (
            <span className="text-sm text-muted-foreground">
              {entries.length} {entries.length === 1 ? "title" : "titles"}
            </span>
          ) : null}
          {activeCount > 0 ? (
            <span className="text-sm text-muted-foreground">
              · {activeCount} active {activeCount === 1 ? "download" : "downloads"}
            </span>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">
          Movies and shows in Jellyfin, plus titles downloading right now.
        </p>
      </div>

      {libraryQuery.error && !libraryQuery.data ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Could not load the Jellyfin library</AlertTitle>
          <AlertDescription>{libraryQuery.error.message}</AlertDescription>
        </Alert>
      ) : null}
      {activityQuery.error && !activityQuery.data ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Could not load active downloads</AlertTitle>
          <AlertDescription>{activityQuery.error.message}</AlertDescription>
        </Alert>
      ) : null}

      {activityNotices?.map((service) => (
        <ActivityServiceNotice key={service.id} service={service} />
      ))}

      {libraryQuery.data && libraryQuery.data.state !== "ok" ? (
        <LibraryStateNotice library={libraryQuery.data} jellyfinUrl={jellyfinUrl} />
      ) : null}

      {loading ? <LibraryGridSkeleton /> : null}

      {!loading && entries.length > 0 ? (
        <Tabs value={filter} onValueChange={(value) => setLibraryFilter(value, setFilter)}>
          <TabsList>
            <TabsTrigger value="all">All ({entries.length})</TabsTrigger>
            <TabsTrigger value="Movie">{`Movies (${countType(entries, "Movie")})`}</TabsTrigger>
            <TabsTrigger value="Series">{`Series (${countType(entries, "Series")})`}</TabsTrigger>
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
      entries.length === 0 &&
      libraryOk &&
      activityQuery.data &&
      activitySettled ? (
        <EmptyLibrary />
      ) : null}
    </section>
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
