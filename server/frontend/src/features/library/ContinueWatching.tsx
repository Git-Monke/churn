import { PlayIcon } from "lucide-react";

import { Progress } from "@/components/ui/progress";
import {
  toContinueWatchingCards,
  type ContinueWatchingCard,
} from "@/features/library/continue-watching-items";
import { useContinueWatching } from "@/features/library/use-continue-watching";

/**
 * Jellyfin's per-user resume list: the last episode in progress per show plus
 * partly watched movies. The row is hidden entirely when there is nothing to
 * resume (or when Jellyfin is unreachable).
 */
export function ContinueWatching() {
  const items = toContinueWatchingCards(useContinueWatching());

  if (items.length === 0) {
    return null;
  }

  return (
    <section aria-labelledby="continue-watching-heading" className="flex flex-col gap-4">
      <h2
        id="continue-watching-heading"
        className="font-heading text-xl font-semibold tracking-tight"
      >
        Continue watching
      </h2>
      <ul className="flex gap-5 overflow-x-auto pb-1">
        {items.map((item) => (
          <li key={item.id} className="w-85 shrink-0">
            <ResumeCard item={item} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function ResumeCard({ item }: { item: ContinueWatchingCard }) {
  return (
    <a
      href={item.href}
      className="group flex h-full flex-col gap-3 rounded-lg transition-transform hover:-translate-y-0.5 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <div className="relative aspect-video overflow-hidden rounded-lg bg-secondary">
        {item.imageUrl ? (
          <img
            src={item.imageUrl}
            alt=""
            loading="lazy"
            className="size-full object-cover"
          />
        ) : (
          <div className="size-full bg-gradient-to-br from-secondary via-secondary/60 to-background" />
        )}
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="flex size-13 items-center justify-center rounded-full bg-background/70 text-foreground shadow-lg">
            <PlayIcon className="size-5 translate-x-px" fill="currentColor" />
          </span>
        </span>
        <Progress
          value={item.progress}
          aria-label={`${item.title} playback progress`}
          className="absolute inset-x-0 bottom-0 h-1 rounded-none bg-foreground/20"
        />
      </div>
      <div className="flex flex-col gap-0.5">
        <span className="truncate font-medium">{item.title}</span>
        <span className="text-sm text-muted-foreground">{item.resumeLabel}</span>
      </div>
    </a>
  );
}
