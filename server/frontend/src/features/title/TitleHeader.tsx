import type { ReactNode } from "react";
import { ChevronLeftIcon, FilmIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Synopsis } from "@/features/title/Synopsis";

export interface TitleHeaderProps {
  poster: { imageUrl?: string; alt: string };
  title: string;
  /** Pre-formatted metadata values; missing fields are simply not passed. */
  metadata: Array<string | undefined>;
  synopsis?: string;
  /** Dim the poster when there is nothing playable yet. */
  dimmed?: boolean;
  /** Primary action: play, resume, not-downloaded or downloading. */
  action: ReactNode;
  /** The "⋯" menu, when the title has actions. */
  menu?: ReactNode;
  /** "Added by …" / "Requested by …". */
  attribution?: ReactNode;
  backHref?: string;
  backLabel?: string;
}

/**
 * The poster, title, metadata, synopsis and primary action shared by every
 * movie and show page. Layout only: pages supply the state-specific pieces.
 */
export function TitleHeader({
  poster,
  title,
  metadata,
  synopsis,
  dimmed = false,
  action,
  menu,
  attribution,
  backHref = "#/library",
  backLabel = "Library",
}: TitleHeaderProps) {
  const values = metadata.filter((value): value is string => Boolean(value));

  return (
    <section className="flex flex-wrap items-end gap-x-10 gap-y-6">
      <div
        className={cn(
          "w-35 shrink-0 overflow-hidden rounded-lg bg-muted sm:w-55",
          dimmed && "opacity-70",
        )}
      >
        {poster.imageUrl ? (
          <img
            src={poster.imageUrl}
            alt={poster.alt}
            className="aspect-[2/3] size-full object-cover"
          />
        ) : (
          <div className="flex aspect-[2/3] size-full items-center justify-center">
            <FilmIcon className="size-8 text-muted-foreground" />
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-[999_1_480px] flex-col gap-4.5">
        <a
          href={backHref}
          className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeftIcon className="size-4" aria-hidden="true" />
          {backLabel}
        </a>

        <h1 className="font-heading text-3xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-5xl">
          {title}
        </h1>

        {values.length > 0 ? (
          <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-sm text-muted-foreground">
            {values.map((value) => (
              <span key={value}>{value}</span>
            ))}
          </div>
        ) : null}

        {synopsis ? <Synopsis text={synopsis} /> : null}

        <div className="flex flex-wrap items-center gap-3">
          {action}
          {menu}
          {attribution ? (
            <div className="ml-2 text-[0.8125rem] text-muted-foreground">
              {attribution}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
