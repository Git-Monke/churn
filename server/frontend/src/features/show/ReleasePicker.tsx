import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleAlertIcon,
  DownloadIcon,
  Loader2Icon,
  RefreshCwIcon,
} from "lucide-react";
import { toast } from "sonner";

import { fetchEpisodeReleases, grabShowRelease } from "@/api/client";
import type { ShowRelease } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

interface ReleasePickerProps {
  seriesId: number;
  seasonNumber: number;
  episodeNumber: number;
  onGrabbed?: () => void;
}

/** Direct Sonarr episode search, kept for repairing a single missing episode. */
export function ReleasePicker({
  seriesId,
  seasonNumber,
  episodeNumber,
  onGrabbed,
}: ReleasePickerProps) {
  const queryClient = useQueryClient();

  const releasesQuery = useQuery({
    queryKey: ["episode-releases", seriesId, seasonNumber, episodeNumber],
    queryFn: () => fetchEpisodeReleases(seriesId, seasonNumber, episodeNumber),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const grabMutation = useMutation({
    mutationFn: (release: ShowRelease) =>
      grabShowRelease("sonarr", String(seriesId), {
        seasonNumber,
        episodeNumber,
        releaseId: release.id,
      }),
    onSuccess: (data) => {
      toast.success(`Sent ${data.title} to qBittorrent`);
      void queryClient.invalidateQueries({ queryKey: ["activity"] });
      void queryClient.invalidateQueries({ queryKey: ["show"] });
      void queryClient.invalidateQueries({ queryKey: ["episode-releases"] });
      void queryClient.invalidateQueries({ queryKey: ["season-releases"] });
      onGrabbed?.();
    },
    onError: (error) => {
      toast.error("Could not grab that release", { description: error.message });
    },
  });

  const releases = (releasesQuery.data?.releases ?? []).filter(
    (release) => release.canGrab,
  );
  const grabbingId = grabMutation.isPending ? grabMutation.variables?.id : undefined;

  return (
    <Card className="gap-3 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4">
        <div className="flex flex-col gap-1">
          <h3 className="font-heading text-base font-semibold">
            Releases for {releaseTargetName(seasonNumber, episodeNumber)}
          </h3>
          <p className="text-sm text-muted-foreground">
            Sonarr is searching this episode. Only releases that explicitly map to this episode
            are shown.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void releasesQuery.refetch()}
          disabled={releasesQuery.isFetching}
        >
          <RefreshCwIcon
            data-icon="inline-start"
            className={releasesQuery.isFetching ? "animate-spin" : undefined}
          />
          Search again
        </Button>
      </div>

      <CardContent className="flex flex-col gap-2 px-4">
        {releasesQuery.isLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" />
            Searching Sonarr indexers…
          </div>
        ) : null}

        {releasesQuery.error ? (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div>
              <p className="font-medium">Release search failed</p>
              <p className="text-muted-foreground">{releasesQuery.error.message}</p>
            </div>
          </div>
        ) : null}

        {!releasesQuery.isLoading && !releasesQuery.error && releases.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">
            Sonarr found no releases for {releaseTargetName(seasonNumber, episodeNumber)}. Try
            again later or add another indexer.
          </p>
        ) : null}

        {releases.map((release) => (
          <div key={release.id} className="flex flex-col gap-2 rounded-lg border p-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant={release.canGrab ? "secondary" : "outline"}>
                {release.canGrab ? "Torrent" : "Unavailable"}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {release.episodeLabel ?? release.seasonLabel}
              </span>
            </div>

            <p className="break-words text-sm font-medium" title={release.title}>
              {release.title}
            </p>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{formatBytes(release.sizeBytes)}</span>
              {release.quality ? <span>{release.quality}</span> : null}
              {release.indexer ? <span>{release.indexer}</span> : null}
              {release.seeders !== undefined ? <span>{release.seeders} seeders</span> : null}
            </div>

            {release.rejections.length > 0 ? (
              <p className="text-xs text-muted-foreground">{release.rejections.join(" · ")}</p>
            ) : null}

            <div className="flex justify-end">
              <Button
                size="sm"
                variant={release.canGrab ? "default" : "outline"}
                disabled={!release.canGrab || grabMutation.isPending}
                onClick={() => grabMutation.mutate(release)}
              >
                {grabbingId === release.id ? (
                  <Loader2Icon data-icon="inline-start" className="animate-spin" />
                ) : (
                  <DownloadIcon data-icon="inline-start" />
                )}
                {grabbingId === release.id ? "Sending…" : "Download"}
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function releaseTargetName(seasonNumber: number, episodeNumber: number): string {
  return `S${String(seasonNumber).padStart(2, "0")}E${String(episodeNumber).padStart(2, "0")}`;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) {
    return "Unknown size";
  }
  if (bytes < 1024 ** 3) {
    return `${Math.round(bytes / 1024 ** 2)} MB`;
  }
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
