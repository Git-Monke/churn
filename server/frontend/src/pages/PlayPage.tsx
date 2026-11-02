import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type Hls from "hls.js";
import {
  ChevronLeftIcon,
  CircleAlertIcon,
  PlayIcon,
  TriangleAlertIcon,
} from "lucide-react";

import {
  fetchPlayback,
  reportPlaybackProgress,
  reportPlaybackStart,
  reportPlaybackStop,
} from "@/api/client";
import type { PlaybackItem, PlaybackReport } from "@/api/types";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const TICKS_PER_SECOND = 10_000_000;
const REPORT_INTERVAL_MS = 10_000;
const RESUME_END_MARGIN_SECONDS = 30;

export function PlayPage({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const playbackQuery = useQuery({
    queryKey: ["playback", id],
    queryFn: () => fetchPlayback(id),
    retry: false,
  });

  const item = playbackQuery.data?.item;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const itemRef = useRef<PlaybackItem | undefined>(undefined);
  const positionRef = useRef(0);
  const startedRef = useRef(false);
  const stoppedRef = useRef(false);
  const resumeAppliedRef = useRef(false);
  const [resumed, setResumed] = useState(false);
  const [mediaError, setMediaError] = useState(false);

  itemRef.current = item;

  const reportProgress = useCallback((isPaused: boolean) => {
    const current = itemRef.current;
    if (!current || stoppedRef.current) {
      return;
    }
    void reportPlaybackProgress(
      current.id,
      reportBody(current, positionRef.current, isPaused),
    ).catch(() => {
      // Reporting is best-effort; the video keeps playing.
    });
  }, []);

  const stopPlayback = useCallback(
    (positionTicks: number) => {
      const current = itemRef.current;
      if (!current || stoppedRef.current) {
        return;
      }
      stoppedRef.current = true;
      const body = reportBody(current, positionTicks, true);
      void reportPlaybackStop(current.id, body)
        .then(() => {
          void queryClient.invalidateQueries({ queryKey: ["playback", current.id] });
        })
        .catch(() => {
          // The session may have expired; the player already has what it needs.
        });
    },
    [queryClient],
  );

  useEffect(() => {
    const interval = window.setInterval(() => {
      const video = videoRef.current;
      if (video && !video.paused && !video.ended) {
        reportProgress(false);
      }
    }, REPORT_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [reportProgress]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !item || item.playbackMethod !== "hls") {
      return;
    }

    setMediaError(false);
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = item.streamUrl;
      return () => {
        video.removeAttribute("src");
        video.load();
      };
    }

    let cancelled = false;
    let hls: Hls | null = null;
    void import("hls.js")
      .then(({ default: HlsConstructor }) => {
        if (cancelled) {
          return;
        }
        if (!HlsConstructor.isSupported()) {
          setMediaError(true);
          return;
        }

        hls = new HlsConstructor();
        hlsRef.current = hls;
        hls.loadSource(item.streamUrl);
        hls.attachMedia(video);
        hls.on(HlsConstructor.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            setMediaError(true);
          }
        });
      })
      .catch(() => {
        if (!cancelled) {
          setMediaError(true);
        }
      });

    return () => {
      cancelled = true;
      hls?.destroy();
      if (hlsRef.current === hls) {
        hlsRef.current = null;
      }
    };
  }, [item?.id, item?.streamUrl, item?.playbackMethod]);

  useEffect(() => {
    const stopFromPageHide = () => {
      const currentItem = itemRef.current;
      if (!currentItem || !startedRef.current || stoppedRef.current) {
        return;
      }
      stoppedRef.current = true;
      sendStopBeacon(currentItem, positionRef.current);
    };
    const stopOnUnmount = () => {
      const currentItem = itemRef.current;
      if (!currentItem || !startedRef.current || stoppedRef.current) {
        return;
      }
      stoppedRef.current = true;
      sendStopKeepalive(currentItem, positionRef.current);
    };

    window.addEventListener("pagehide", stopFromPageHide);
    return () => {
      window.removeEventListener("pagehide", stopFromPageHide);
      stopOnUnmount();
      const currentItem = itemRef.current;
      if (currentItem) {
        void queryClient.invalidateQueries({ queryKey: ["playback", currentItem.id] });
      }
    };
  }, [queryClient]);

  function handleLoadedMetadata() {
    const video = videoRef.current;
    if (!video || !item || resumeAppliedRef.current) {
      return;
    }
    resumeAppliedRef.current = true;
    const resumeSeconds = (item.positionTicks ?? 0) / TICKS_PER_SECOND;
    if (resumeSeconds <= 0 || item.played) {
      return;
    }
    const duration = video.duration;
    const nearEnd =
      Number.isFinite(duration) &&
      resumeSeconds >= duration - RESUME_END_MARGIN_SECONDS;
    if (!nearEnd) {
      video.currentTime = resumeSeconds;
      positionRef.current = Math.round(resumeSeconds * TICKS_PER_SECOND);
      setResumed(true);
    }
  }

  function handlePlay() {
    if (!item || startedRef.current) {
      return;
    }
    startedRef.current = true;
    void reportPlaybackStart(
      item.id,
      reportBody(item, positionRef.current, false),
    ).catch(() => {
      // Reporting is best-effort.
    });
  }

  function handleTimeUpdate() {
    const video = videoRef.current;
    if (video) {
      positionRef.current = Math.round(video.currentTime * TICKS_PER_SECOND);
    }
  }

  function handlePause() {
    const video = videoRef.current;
    if (video && !video.ended) {
      positionRef.current = Math.round(video.currentTime * TICKS_PER_SECOND);
      reportProgress(true);
    }
  }

  function handleEnded() {
    const video = videoRef.current;
    const duration = video?.duration;
    const durationTicks =
      duration !== undefined && Number.isFinite(duration)
        ? Math.round(duration * TICKS_PER_SECOND)
        : positionRef.current;
    stopPlayback(durationTicks);
  }

  if (playbackQuery.isLoading) {
    return <PlaybackLoading />;
  }

  if (playbackQuery.error && !playbackQuery.data) {
    return (
      <PlaybackMessage
        title="Could not load this video"
        detail={playbackQuery.error.message}
      />
    );
  }

  if (!item || playbackQuery.data?.state !== "ok") {
    const state = playbackQuery.data?.state;
    return (
      <PlaybackMessage
        title={state === "unauthorized" ? "Jellyfin sign-in expired" : "Playback unavailable"}
        detail={
          playbackQuery.data?.detail ??
          (state === "unauthorized"
            ? "Sign out and sign in again to refresh your Jellyfin session."
            : "Check that Jellyfin is running and reachable, then try again.")
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <a
        href="#/library"
        className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeftIcon className="size-4" />
        Back to Library
      </a>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{item.type}</Badge>
          {item.type === "Episode" && item.seasonNumber !== undefined && item.episodeNumber !== undefined ? (
            <span className="font-mono text-xs text-muted-foreground">
              {episodeCode(item.seasonNumber, item.episodeNumber)}
            </span>
          ) : null}
          {item.year ? (
            <span className="text-sm text-muted-foreground">{item.year}</span>
          ) : null}
          {item.runtimeTicks !== undefined ? (
            <span className="text-sm text-muted-foreground">
              {formatRuntimeTicks(item.runtimeTicks)}
            </span>
          ) : null}
          {resumed ? <Badge variant="secondary">Resumed</Badge> : null}
        </div>
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            {item.name}
          </h1>
          {item.type === "Episode" && item.seriesName ? (
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span>{item.seriesName}</span>
              {item.seriesId ? (
                <a
                  href={`#/library/show/jellyfin/${encodeURIComponent(item.seriesId)}`}
                  className="underline-offset-4 hover:text-foreground hover:underline"
                >
                  View show
                </a>
              ) : null}
            </div>
          ) : null}
          {item.overview ? (
            <p className="max-w-3xl text-sm text-muted-foreground">{item.overview}</p>
          ) : null}
        </div>
      </div>

      {item.playbackMethod === "hls" ? (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>Transcoding for browser playback</AlertTitle>
          <AlertDescription>
            Jellyfin is converting this file to a browser-compatible stream.
            Audio and video may take a moment to start.
          </AlertDescription>
        </Alert>
      ) : null}

      {mediaError ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>This video could not play in the browser</AlertTitle>
          <AlertDescription>
            The file may use a codec the browser cannot decode. Open Jellyfin to
            watch it there.
          </AlertDescription>
          <AlertAction>
            <Button asChild variant="outline" size="sm">
              <a
                href="/api/services/jellyfin/open"
                target="_blank"
                rel="noreferrer"
              >
                Open Jellyfin
              </a>
            </Button>
          </AlertAction>
        </Alert>
      ) : null}

      <Card className="gap-0 overflow-hidden bg-black py-0">
        <video
          ref={videoRef}
          className="aspect-video w-full bg-black"
          controls
          playsInline
          preload="metadata"
          poster={item.imageUrl}
          src={item.playbackMethod === "direct" ? item.streamUrl : undefined}
          onLoadedMetadata={handleLoadedMetadata}
          onPlay={handlePlay}
          onPause={handlePause}
          onTimeUpdate={handleTimeUpdate}
          onEnded={handleEnded}
          onError={() => setMediaError(true)}
        />
      </Card>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <PlayIcon className="size-3.5" />
        Progress and watched state sync to Jellyfin.
      </div>
    </div>
  );
}

function PlaybackMessage({
  title,
  detail,
}: {
  title: string;
  detail: string;
}) {
  return (
    <div className="flex flex-col gap-6">
      <a
        href="#/library"
        className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeftIcon className="size-4" />
        Back to Library
      </a>
      <Alert variant="destructive">
        <CircleAlertIcon />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{detail}</AlertDescription>
        <AlertAction>
          <Button asChild variant="outline" size="sm">
            <a
              href="/api/services/jellyfin/open"
              target="_blank"
              rel="noreferrer"
            >
              Open Jellyfin
            </a>
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
}

function PlaybackLoading() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-4 w-28" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-4 w-full max-w-2xl" />
      </div>
      <Skeleton className="aspect-video w-full rounded-xl" />
    </div>
  );
}

function reportBody(
  item: PlaybackItem,
  positionTicks: number,
  isPaused: boolean,
): PlaybackReport {
  return {
    positionTicks,
    mediaSourceId: item.mediaSourceId,
    playSessionId: item.playSessionId,
    isPaused,
  };
}

function sendStopBeacon(item: PlaybackItem, positionTicks: number): void {
  if (typeof navigator === "undefined" || typeof navigator.sendBeacon !== "function") {
    sendStopKeepalive(item, positionTicks);
    return;
  }
  const body = JSON.stringify(reportBody(item, positionTicks, true));
  const blob = new Blob([body], { type: "application/json" });
  const sent = navigator.sendBeacon(
    `/api/playback/items/${encodeURIComponent(item.id)}/stop`,
    blob,
  );
  if (!sent) {
    sendStopKeepalive(item, positionTicks);
  }
}

function sendStopKeepalive(item: PlaybackItem, positionTicks: number): void {
  const body = JSON.stringify(reportBody(item, positionTicks, true));
  void fetch(`/api/playback/items/${encodeURIComponent(item.id)}/stop`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => {
    // Best-effort on navigation or unmount.
  });
}

function episodeCode(season: number, episode: number): string {
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

function formatRuntimeTicks(ticks: number): string {
  const minutes = Math.round(ticks / 600_000_000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}
