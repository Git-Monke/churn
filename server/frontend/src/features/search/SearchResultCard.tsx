import { useCallback, useId, useRef } from "react";
import type { ReactNode } from "react";
import {
  CheckIcon,
  ClockIcon,
  FilmIcon,
  Loader2Icon,
  PlusIcon,
  TvIcon,
} from "lucide-react";

import { MotionImage } from "@/components/MotionImage";
import type { SearchResult } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";

interface SearchResultCardProps {
  result: SearchResult;
  onRequest: (result: SearchResult) => void;
  requesting: boolean;
  requestHref?: string;
  requestError?: string;
  requestDisabled: boolean;
}

export function SearchResultCard({
  result,
  onRequest,
  requesting,
  requestHref,
  requestError,
  requestDisabled,
}: SearchResultCardProps) {
  const errorId = useId();
  const restoreFocus = useRef(false);
  const trackAction = useCallback((node: HTMLButtonElement | HTMLAnchorElement | null) => {
    if (!node) return;
    if (restoreFocus.current) {
      restoreFocus.current = false;
      node.focus({ preventScroll: true });
    }
    return () => {
      restoreFocus.current = document.activeElement === node;
    };
  }, []);
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
          <MotionImage
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
          {requestError ? (
            <p id={errorId} role="alert" className="text-xs text-destructive">
              {requestError}
            </p>
          ) : null}
          {available ? (
            <StatusState icon={<CheckIcon />} label="Available" />
          ) : requestHref && requested ? (
            <Button asChild size="sm" className="motion-action-swap w-full">
              <a href={requestHref} ref={trackAction}>
                Pick a version
              </a>
            </Button>
          ) : requested ? (
            <StatusState icon={<ClockIcon />} label="Requested" />
          ) : (
            <Button
              size="sm"
              ref={trackAction}
              className="w-full aria-disabled:opacity-50"
              aria-disabled={requestDisabled || requesting}
              aria-describedby={requestError ? errorId : undefined}
              onClick={() => {
                if (!requestDisabled && !requesting) onRequest(result);
              }}
            >
              {requesting ? (
                <Loader2Icon data-icon="inline-start" className="animate-spin" />
              ) : (
                <PlusIcon data-icon="inline-start" />
              )}
              {requesting ? "Requesting…" : requestError ? "Retry request" : "Request"}
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
