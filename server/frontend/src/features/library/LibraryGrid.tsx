import { useState } from "react";

import { MotionImage } from "@/components/MotionImage";
import { Skeleton } from "@/components/ui/skeleton";
import type { LibraryEntry } from "@/features/library/library-entries";
import { entryHref, entryTitle } from "@/features/library/library-entries";

export function LibraryGrid({ entries, newlyReady }: { entries: LibraryEntry[]; newlyReady: ReadonlySet<string> }) {
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-x-5 gap-y-6">
      {entries.map((entry) => (
        <li key={entry.key}>
          <LibraryCard entry={entry} ready={newlyReady.has(entry.key)} />
        </li>
      ))}
    </ul>
  );
}

export function LibraryGridSkeleton() {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-x-5 gap-y-6">
      {Array.from({ length: 12 }).map((_, index) => (
        <Skeleton key={index} className="aspect-[2/3] w-full rounded-lg" />
      ))}
    </div>
  );
}

function LibraryCard({ entry, ready }: { entry: LibraryEntry; ready: boolean }) {
  const title = entryTitle(entry) || "Untitled";
  const imageUrl =
    entry.library?.imageUrl ?? entry.requested?.imageUrl ?? entry.activity?.imageUrl;
  const href = entryHref(entry);
  const [failedPosterUrl, setFailedPosterUrl] = useState<string | null>(null);
  const showPoster = Boolean(imageUrl) && failedPosterUrl !== imageUrl;

  const poster = (
    <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-muted">
      {showPoster ? (
        <MotionImage
          src={imageUrl}
          alt={`${title} poster`}
          loading="lazy"
          className="size-full object-cover"
          onError={() => setFailedPosterUrl(imageUrl ?? null)}
        />
      ) : (
        <div className="flex size-full items-center justify-center px-3">
          <span className="line-clamp-4 text-center text-sm font-medium text-balance">
            {title}
          </span>
        </div>
      )}
      {ready ? (
        <span
          role="status"
          className="motion-ready absolute top-2 left-2 rounded bg-background px-2 py-1 text-xs font-medium text-primary"
        >
          Ready to play
        </span>
      ) : null}
    </div>
  );

  const className =
    "group block rounded-lg focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none";

  if (!href) {
    return <div className={className}>{poster}</div>;
  }

  return (
    <a href={href} data-library-title className={`${className} motion-poster-card`}>
      {poster}
    </a>
  );
}
