import { useState } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import type { LibraryEntry } from "@/features/library/library-entries";
import { entryHref, entryTitle } from "@/features/library/library-entries";

export function LibraryGrid({ entries }: { entries: LibraryEntry[] }) {
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-x-5 gap-y-6">
      {entries.map((entry) => (
        <li key={entry.key}>
          <LibraryCard entry={entry} />
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

function LibraryCard({ entry }: { entry: LibraryEntry }) {
  const title = entryTitle(entry) || "Untitled";
  const imageUrl =
    entry.library?.imageUrl ?? entry.requested?.imageUrl ?? entry.activity?.imageUrl;
  const href = entryHref(entry);
  const [failedPosterUrl, setFailedPosterUrl] = useState<string | null>(null);
  const showPoster = Boolean(imageUrl) && failedPosterUrl !== imageUrl;

  const poster = (
    <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-muted">
      {showPoster ? (
        <img
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
    </div>
  );

  const className =
    "group block rounded-lg focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none";

  if (!href) {
    return <div className={className}>{poster}</div>;
  }

  return (
    <a href={href} className={`${className} transition-transform hover:-translate-y-0.5`}>
      {poster}
    </a>
  );
}
