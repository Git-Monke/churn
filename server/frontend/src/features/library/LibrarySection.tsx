import { useMemo, useState } from "react";
import { CircleAlertIcon, FilmIcon } from "lucide-react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import type { LibraryItem, LibraryResponse } from "@/api/types";

type Filter = "all" | "Movie" | "Series";

interface LibrarySectionProps {
  library?: LibraryResponse;
  loading: boolean;
  error: Error | null;
  jellyfinUrl?: string;
}

export function LibrarySection({ library, loading, error, jellyfinUrl }: LibrarySectionProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const items = library?.items ?? [];
  const filtered = useMemo(
    () => (filter === "all" ? items : items.filter((item) => item.type === filter)),
    [filter, items],
  );

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-heading text-xl font-semibold tracking-tight">Library</h2>
          {library?.source === "jellyfin" ? <Badge variant="outline">Jellyfin</Badge> : null}
          {library?.state === "ok" ? (
            <span className="text-sm text-muted-foreground">
              {library.total} {library.total === 1 ? "title" : "titles"}
            </span>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">Movies and shows available in Jellyfin.</p>
      </div>

      {loading && !library ? <LibraryGridSkeleton /> : null}
      {error && !library ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Could not load the library</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : null}
      {library && library.state !== "ok" ? (
        <LibraryStateNotice library={library} jellyfinUrl={jellyfinUrl} />
      ) : null}
      {library?.state === "ok" && library.items.length === 0 ? <EmptyLibrary /> : null}

      {library?.state === "ok" && library.items.length > 0 ? (
        <Tabs value={filter} onValueChange={(value) => setLibraryFilter(value, setFilter)}>
          <TabsList>
            <TabsTrigger value="all">All ({library.items.length})</TabsTrigger>
            <TabsTrigger value="Movie">{`Movies (${countType(library.items, "Movie")})`}</TabsTrigger>
            <TabsTrigger value="Series">{`Series (${countType(library.items, "Series")})`}</TabsTrigger>
          </TabsList>
          <TabsContent value={filter}>
            {filtered.length > 0 ? (
              <LibraryGrid items={filtered} />
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
    </section>
  );
}

function LibraryStateNotice({
  library,
  jellyfinUrl,
}: {
  library: LibraryResponse;
  jellyfinUrl?: string;
}) {
  if (library.state === "setup_required") {
    return (
      <Alert>
        <CircleAlertIcon />
        <AlertTitle>Finish Jellyfin setup</AlertTitle>
        <AlertDescription>
          Jellyfin&apos;s first-run wizard is not complete, so there is no library to show yet.
          Re-run the churn installer to finish setup and create the dashboard API key, or
          complete the wizard and add <code>JELLYFIN_API_KEY</code> to <code>server/.env</code>.
        </AlertDescription>
        <AlertAction>
          <Button asChild variant="outline" size="sm">
            <a href="/api/services/jellyfin/open" target="_blank" rel="noreferrer">
              Open Jellyfin
            </a>
          </Button>
        </AlertAction>
      </Alert>
    );
  }
  if (library.state === "unconfigured") {
    return (
      <Alert>
        <CircleAlertIcon />
        <AlertTitle>Jellyfin API key required</AlertTitle>
        <AlertDescription>
          Re-run the churn installer to create the dashboard API key, or add
          <code>JELLYFIN_API_KEY</code> to <code>server/.env</code> and restart the backend.
          You can create a key in Jellyfin under Dashboard → API Keys.
        </AlertDescription>
        <AlertAction>
          <Button asChild variant="outline" size="sm">
            <a href="/api/services/jellyfin/open" target="_blank" rel="noreferrer">
              Open Jellyfin
            </a>
          </Button>
        </AlertAction>
      </Alert>
    );
  }
  if (library.state === "unauthorized") {
    return (
      <Alert variant="destructive">
        <CircleAlertIcon />
        <AlertTitle>Jellyfin rejected the API key</AlertTitle>
        <AlertDescription>
          Check <code>JELLYFIN_API_KEY</code> in <code>server/.env</code> and restart the
          backend. You can create a new key in Jellyfin under Dashboard → API Keys.
        </AlertDescription>
        <AlertAction>
          <Button asChild variant="outline" size="sm">
            <a href="/api/services/jellyfin/open" target="_blank" rel="noreferrer">
              Open Jellyfin
            </a>
          </Button>
        </AlertAction>
      </Alert>
    );
  }
  return (
    <Alert variant="destructive">
      <CircleAlertIcon />
      <AlertTitle>Jellyfin is unreachable</AlertTitle>
      <AlertDescription>
        Could not reach {jellyfinUrl ?? "Jellyfin"}. Check that the Jellyfin container is running
        and that <code>JELLYFIN_URL</code> is correct.
        {library.detail ? ` ${library.detail}` : ""}
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
        <EmptyTitle>No media in Jellyfin yet</EmptyTitle>
        <EmptyDescription>
          Add movies or shows under <code>/data/media</code>, then run a library scan in
          Jellyfin. Titles will appear here once Jellyfin indexes them.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild variant="outline" size="sm">
          <a href="/api/services/jellyfin/open" target="_blank" rel="noreferrer">
            Open Jellyfin
          </a>
        </Button>
      </EmptyContent>
    </Empty>
  );
}

function countType(items: LibraryItem[], type: LibraryItem["type"]): number {
  return items.filter((item) => item.type === type).length;
}

function setLibraryFilter(value: string, setFilter: (value: Filter) => void): void {
  if (value === "all" || value === "Movie" || value === "Series") {
    setFilter(value);
  }
}
