import { PlayIcon } from "lucide-react";

import { Progress } from "@/components/ui/progress";

export interface ContinueWatchingItem {
  id: string;
  /** Show name for episodes, movie title for films. */
  title: string;
  /** `S3 · E5 · 14 min left` for episodes, `48 min left` for movies. */
  resumeLabel: string;
  /** Played percentage, 0–100. */
  progress: number;
  /** Optional still; the card falls back to a token-coloured placeholder. */
  imageUrl?: string;
  /** Present once real resume data (and therefore a playable item id) exists. */
  href?: string;
}

/**
 * Placeholder resume list: the backend does not proxy Jellyfin's
 * `UserItems/Resume` yet. Tracked as a follow-up bean; swap this for the real
 * query (`fetchResume`) once the route lands.
 */
const MOCK_CONTINUE_WATCHING: ContinueWatchingItem[] = [
  {
    id: "mock-parks-and-recreation",
    title: "Parks and Recreation",
    resumeLabel: "S3 · E5 · 14 min left",
    progress: 45,
  },
  {
    id: "mock-30-rock",
    title: "30 Rock",
    resumeLabel: "S1 · E8 · 16 min left",
    progress: 28,
  },
  {
    id: "mock-ninja-scroll",
    title: "Ninja Scroll",
    resumeLabel: "48 min left",
    progress: 52,
  },
];

export function ContinueWatching({
  items = MOCK_CONTINUE_WATCHING,
}: {
  items?: ContinueWatchingItem[];
}) {
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
            <ContinueWatchingCard item={item} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function ContinueWatchingCard({ item }: { item: ContinueWatchingItem }) {
  const body = (
    <>
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
    </>
  );

  const className =
    "group flex h-full flex-col gap-3 rounded-lg transition-transform focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none";

  if (!item.href) {
    return <div className={className}>{body}</div>;
  }

  return (
    <a href={item.href} className={`${className} hover:-translate-y-0.5`}>
      {body}
    </a>
  );
}
