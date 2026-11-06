import type { ShowSeason } from "@/api/types";
import { cn } from "@/lib/utils";

/**
 * Underlined season tabs. The rule under the row doubles as the separator above
 * the episode list, so each tab's 2px border sits on top of it.
 */
export function SeasonTabs({
  seasons,
  selected,
  onSelect,
}: {
  seasons: ShowSeason[];
  selected: number | null;
  onSelect: (seasonNumber: number) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Seasons"
      className="flex gap-1 overflow-x-auto border-b border-border [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {seasons.map((season) => {
        const active = season.seasonNumber === selected;
        const hasMissing = season.availableCount < season.episodeCount;
        return (
          <button
            key={season.seasonNumber}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(season.seasonNumber)}
            className={cn(
              "-mb-px flex min-h-12 shrink-0 items-center border-b-2 px-4 text-[15px] whitespace-nowrap transition-colors",
              "focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
              active
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {season.name}
            {hasMissing ? (
              <span
                role="img"
                aria-label="has episodes not downloaded"
                className="ml-1.5 inline-block size-1.5 shrink-0 rounded-full bg-primary"
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
