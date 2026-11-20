import type { ShowSeason } from "@/api/types";
import { useSelectionUnderline } from "@/hooks/use-selection-underline";
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
  const { track, indicator, onClick } = useSelectionUnderline<HTMLDivElement>(selected, true);
  return (
    <div
      ref={track}
      role="tablist"
      aria-label="Seasons"
      className="relative flex gap-1 overflow-x-auto border-b border-border [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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
            tabIndex={active || (selected === null && season === seasons[0]) ? 0 : -1}
            onKeyDown={(event) => {
              const index = seasons.indexOf(season);
              const nextIndex = {
                ArrowLeft: (index - 1 + seasons.length) % seasons.length,
                ArrowRight: (index + 1) % seasons.length,
                Home: 0,
                End: seasons.length - 1,
              }[event.key];
              if (nextIndex === undefined) return;
              const next = seasons[nextIndex];
              if (!next) return;
              event.preventDefault();
              track.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]
                ?.focus({ preventScroll: true });
              onSelect(next.seasonNumber);
            }}
            data-underline-active={active ? "" : undefined}
            onClick={(event) => {
              onClick(event, !active);
              onSelect(season.seasonNumber);
            }}
            className={cn(
              "-mb-px flex min-h-12 shrink-0 items-center border-b-2 px-4 text-[15px] whitespace-nowrap transition-colors",
              "focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
              active
                ? "border-transparent text-foreground"
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
      <span ref={indicator} hidden aria-hidden="true" className="motion-selection-underline" />
    </div>
  );
}
