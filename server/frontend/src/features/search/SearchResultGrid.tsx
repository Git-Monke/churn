import { useMemo, useState } from "react";
import { SearchIcon } from "lucide-react";

import type { RequestMonitor, SearchResult } from "@/api/types";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SearchResultCard } from "@/features/search/SearchResultCard";

type Filter = "all" | "movie" | "series";

interface SearchResultGridProps {
  results: SearchResult[];
  onRequest: (result: SearchResult) => void;
  requestingKey: string | null;
  requestDisabled: boolean;
  seriesMonitor?: RequestMonitor;
}

export function SearchResultGrid({
  results,
  onRequest,
  requestingKey,
  requestDisabled,
  seriesMonitor,
}: SearchResultGridProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const filtered = useMemo(
    () => (filter === "all" ? results : results.filter((result) => result.kind === filter)),
    [filter, results],
  );

  return (
    <Tabs value={filter} onValueChange={(value) => setFilter(value as Filter)}>
      <TabsList>
        <TabsTrigger value="all">All ({results.length})</TabsTrigger>
        <TabsTrigger value="movie">{`Movies (${countKind(results, "movie")})`}</TabsTrigger>
        <TabsTrigger value="series">{`Series (${countKind(results, "series")})`}</TabsTrigger>
      </TabsList>
      <TabsContent value={filter}>
        {filtered.length > 0 ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
            {filtered.map((result) => (
              <SearchResultCard
                key={result.key}
                result={result}
                onRequest={onRequest}
                requesting={requestingKey === result.key}
                requestDisabled={requestDisabled}
                seriesMonitor={seriesMonitor}
              />
            ))}
          </div>
        ) : (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SearchIcon />
              </EmptyMedia>
              <EmptyTitle>Nothing in this view</EmptyTitle>
              <EmptyDescription>
                No {filter === "movie" ? "movies" : "series"} match this search.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </TabsContent>
    </Tabs>
  );
}

export function SearchResultGridSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
      {Array.from({ length: 12 }).map((_, index) => (
        <div key={index} className="flex flex-col gap-2">
          <Skeleton className="aspect-[2/3] w-full rounded-xl" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-3 w-2/5" />
          <Skeleton className="h-8 w-full" />
        </div>
      ))}
    </div>
  );
}

function countKind(results: SearchResult[], kind: SearchResult["kind"]): number {
  return results.filter((result) => result.kind === kind).length;
}
