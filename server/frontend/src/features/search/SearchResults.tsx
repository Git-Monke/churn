import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { SearchIcon } from "lucide-react";

import type { SearchResult } from "@/api/types";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SearchResultCard } from "@/features/search/SearchResultCard";

/** Titles below this vote count are treated as noise until asked for. */
const MIN_VISIBLE_VOTES = 20;

type Filter = "all" | "movie" | "series";

interface SearchResultsProps {
  query: string;
  results: SearchResult[];
  showNiche: boolean;
  onShowNicheChange: (showNiche: boolean) => void;
  pending: boolean;
  requestLinks: Record<string, string>;
  requestErrors: Record<string, string>;
  onRequest: (result: SearchResult) => void;
  requestingKey: string | null;
  requestDisabled: boolean;
}

export function SearchResults({
  query,
  results,
  showNiche,
  onShowNicheChange,
  pending,
  requestLinks,
  requestErrors,
  onRequest,
  requestingKey,
  requestDisabled,
}: SearchResultsProps) {
  const grid = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const fade = grid.current?.animate([{ opacity: 0.65 }, { opacity: 1 }], {
      duration: 130,
      easing: "cubic-bezier(0.23, 1, 0.32, 1)",
    });
    return () => fade?.cancel();
  }, [query]);
  const [filter, setFilter] = useState<Filter>("all");
  const visible = useMemo(
    () =>
      showNiche
        ? results
        : results.filter((result) => (result.votes ?? 0) >= MIN_VISIBLE_VOTES),
    [results, showNiche],
  );
  const hiddenCount = results.length - visible.length;
  const filtered = useMemo(
    () => (filter === "all" ? visible : visible.filter((result) => result.kind === filter)),
    [filter, visible],
  );

  return (
    <Tabs
      className="gap-6"
      value={filter}
      onValueChange={(value) => setFilter(value as Filter)}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <TabsList>
          <TabsTrigger value="all">All ({visible.length})</TabsTrigger>
          <TabsTrigger value="movie">{`Movies (${countKind(visible, "movie")})`}</TabsTrigger>
          <TabsTrigger value="series">{`Series (${countKind(visible, "series")})`}</TabsTrigger>
        </TabsList>
        <span role="status" className="text-xs text-muted-foreground">
          {pending ? (
            "Updating results…"
          ) : (
            <span className="sr-only">
              {visible.length} results for {query}
            </span>
          )}
        </span>
        {hiddenCount > 0 || showNiche ? (
          <div className="flex items-center gap-2">
            <Switch
              id="show-niche-results"
              size="sm"
              checked={showNiche}
              onCheckedChange={onShowNicheChange}
            />
            <Label
              htmlFor="show-niche-results"
              className="text-sm font-normal text-muted-foreground"
            >
              Show niche results
              {hiddenCount > 0 ? ` (${hiddenCount} hidden)` : ""}
            </Label>
          </div>
        ) : null}
      </div>
      <TabsContent value={filter}>
        {filtered.length > 0 ? (
          <div
            ref={grid}
            className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6"
          >
            {filtered.map((result) => (
              <SearchResultCard
                key={result.key}
                result={result}
                onRequest={onRequest}
                requestHref={requestLinks[result.key]}
                requestError={requestErrors[result.key]}
                requesting={requestingKey === result.key}
                requestDisabled={requestDisabled}
              />
            ))}
          </div>
        ) : visible.length === 0 && hiddenCount > 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SearchIcon />
              </EmptyMedia>
              <EmptyTitle>Only niche results for “{query}”</EmptyTitle>
              <EmptyDescription>
                {hiddenCount} {hiddenCount === 1 ? "result has" : "results have"} fewer than{" "}
                {MIN_VISIBLE_VOTES} votes. Turn on “Show niche results” to see
                {hiddenCount === 1 ? " it" : " them"}.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
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

export function SearchResultsSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
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
