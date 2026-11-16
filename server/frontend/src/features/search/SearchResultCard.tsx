import {
  CheckIcon,
  ClockIcon,
  FilmIcon,
  Loader2Icon,
  PlusIcon,
  TvIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import type { SearchResult } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";

interface SearchResultCardProps {
  result: SearchResult;
  onRequest: (result: SearchResult) => void;
  requesting: boolean;
  requestDisabled: boolean;
}

export function SearchResultCard({
  result,
  onRequest,
  requesting,
  requestDisabled,
}: SearchResultCardProps) {
  const available = result.available === true;
  const requested = !available && result.inLibrary === true;

  const facts = [
    result.kind === "movie" ? "Movie" : "Series",
    result.year ? String(result.year) : null,
    result.rating === undefined ? null : `${result.rating.toFixed(1)}/10`,
  ].filter((fact): fact is string => fact !== null);

  return (
    <Card className="gap-0 py-0">
      <div className="aspect-[2/3] bg-muted">
        {result.imageUrl ? (
          <img
            src={result.imageUrl}
            alt={`${result.title} poster`}
            loading="lazy"
            className="size-full object-cover"
          />
        ) : (
          <div className="flex size-full items-center justify-center">
            {result.kind === "movie" ? (
              <FilmIcon className="size-8 text-muted-foreground" />
            ) : (
              <TvIcon className="size-8 text-muted-foreground" />
            )}
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-3 p-3">
        <div className="flex flex-col gap-1">
          <CardTitle className="truncate text-base" title={result.title}>
            {result.title}
          </CardTitle>
          <p className="truncate text-xs text-muted-foreground tabular-nums">
            {facts.join(" · ")}
          </p>
        </div>

        {result.overview ? (
          <p className="line-clamp-2 text-sm text-muted-foreground">{result.overview}</p>
        ) : null}

        <div className="mt-auto flex flex-col gap-1.5">
          {result.inLibrary === null ? (
            <p className="text-xs text-muted-foreground">Status unknown</p>
          ) : null}
          {available ? (
            <StatusState icon={<CheckIcon />} label="Available" />
          ) : requested ? (
            <StatusState icon={<ClockIcon />} label="Requested" />
          ) : (
            <Button
              size="sm"
              className="w-full"
              disabled={requestDisabled || requesting}
              onClick={() => onRequest(result)}
            >
              {requesting ? (
                <Loader2Icon data-icon="inline-start" className="animate-spin" />
              ) : (
                <PlusIcon data-icon="inline-start" />
              )}
              {requesting ? "Requesting…" : "Request"}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

function StatusState({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className="flex h-7 items-center gap-1.5 text-xs text-muted-foreground">
      <span aria-hidden className="[&>svg]:size-3.5">
        {icon}
      </span>
      {label}
    </div>
  );
}
