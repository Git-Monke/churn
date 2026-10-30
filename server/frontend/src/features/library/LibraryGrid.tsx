import { FilmIcon, TvIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { LibraryItem } from "@/api/types";

export function LibraryGrid({ items }: { items: LibraryItem[] }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
      {items.map((item) => (
        <LibraryCard key={item.id} item={item} />
      ))}
    </div>
  );
}

export function LibraryGridSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
      {Array.from({ length: 12 }).map((_, index) => (
        <div key={index} className="flex flex-col gap-2">
          <Skeleton className="aspect-[2/3] w-full rounded-xl" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-3 w-2/5" />
        </div>
      ))}
    </div>
  );
}

function LibraryCard({ item }: { item: LibraryItem }) {
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="aspect-[2/3] bg-muted">
        {item.imageUrl ? (
          <img
            src={item.imageUrl}
            alt={`${item.name} poster`}
            loading="lazy"
            className="size-full object-cover"
          />
        ) : (
          <div className="flex size-full items-center justify-center">
            {item.type === "Movie" ? (
              <FilmIcon className="size-8 text-muted-foreground" />
            ) : (
              <TvIcon className="size-8 text-muted-foreground" />
            )}
          </div>
        )}
      </div>
      <CardContent className="flex flex-col gap-1.5 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary">{item.type === "Movie" ? "Movie" : "Series"}</Badge>
          {item.year ? <span className="text-xs text-muted-foreground">{item.year}</span> : null}
        </div>
        <h3 className="truncate font-medium" title={item.name}>
          {item.name}
        </h3>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {item.rating !== undefined ? <span>{item.rating.toFixed(1)} / 10</span> : null}
          {item.officialRating ? <span>{item.officialRating}</span> : null}
          {item.runtimeMinutes !== undefined ? <span>{formatRuntime(item.runtimeMinutes)}</span> : null}
        </div>
      </CardContent>
    </Card>
  );
}

function formatRuntime(minutes: number): string {
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}
