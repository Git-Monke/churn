import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type Hls from "hls.js";
import { toast } from "sonner";
import {
  ChevronLeftIcon,
  CircleAlertIcon,
  LoaderCircleIcon,
  PlayIcon,
  TriangleAlertIcon,
} from "lucide-react";

import {
  fetchPlayback,
  reportPlaybackProgress,
  reportPlaybackStart,
  reportPlaybackStop,
} from "@/api/client";
import type {
  PlaybackItem,
  PlaybackQuality,
  PlaybackReport,
} from "@/api/types";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

const TICKS_PER_SECOND = 10_000_000;
const REPORT_INTERVAL_MS = 10_000;
const RESUME_END_MARGIN_SECONDS = 30;
// Advance further each time so the new segment request makes Jellyfin restart
// its transcode past a damaged section instead of on the same bad keyframe.
const RECOVERY_SKIP_SECONDS = [5, 15, 30];
const RECOVERY_RETRY_MS = 12_000;
const RECOVERY_FATAL_GRACE_MS = 1_500;

type MediaIssue = "codec" | "stream";

export function PlayPage({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const [quality, setQuality] = useState<PlaybackQuality>("max");
  const playbackQuery = useQuery({
    queryKey: ["playback", id, quality],
    queryFn: () => fetchPlayback(id, quality),
    retry: false,
    // Keep the current stream on screen while a new quality is fetched instead
    // of dropping back to the loading skeleton.
    placeholderData: (previous) => previous,
  });

  const item = playbackQuery.data?.item;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const itemRef = useRef<PlaybackItem | undefined>(undefined);
  const positionRef = useRef(0);
  const startedRef = useRef(false);
  const stoppedRef = useRef(false);
  const resumeAppliedRef = useRef(false);
  // Set when a quality switch is requested; the next stream starts here.
  const qualitySwitchRef = useRef<{
    quality: PlaybackQuality;
    ticks: number;
    paused: boolean;
    previous?: PlaybackItem;
  } | null>(null);
  const [switchingQuality, setSwitchingQuality] = useState(false);
  const [resumed, setResumed] = useState(false);
  const [mediaIssue, setMediaIssue] = useState<MediaIssue | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [recovery, setRecovery] = useState<{
    itemId: string;
    targetTicks: number;
    attempt: number;
  } | null>(null);
  const recoveryRef = useRef({ attempts: 0, lastTarget: 0 });
  const recoveringRef = useRef(false);
  const recoveryStartedAtRef = useRef(0);
  const recoveryTimerRef = useRef<number | null>(null);

  itemRef.current = item;

  // Finish a quality switch once the backend answers with the new stream: the
  // previous Jellyfin play session is stopped and the new one starts at the
  // position the old stream had reached.
  useEffect(() => {
    const pending = qualitySwitchRef.current;
    const current = itemRef.current;
    if (!pending || !current || current.quality !== pending.quality) {
      return;
    }
    if (startedRef.current) {
      if (
        pending.previous &&
        pending.previous.playSessionId !== current.playSessionId
      ) {
        void reportPlaybackStop(
          pending.previous.id,
          reportBody(pending.previous, pending.ticks, true),
        ).catch(() => {
          // The old session may already be gone; nothing to clean up.
        });
      }
      void reportPlaybackStart(
        current.id,
        reportBody(current, pending.ticks, false),
      ).catch(() => {
        // Reporting is best-effort; the new stream keeps playing.
      });
    }
    setSwitchingQuality(false);
  }, [item?.streamUrl, item?.quality]);

  // A failed quality switch keeps the current stream and reverts the picker.
  useEffect(() => {
    if (!playbackQuery.error || !item || !qualitySwitchRef.current) {
      return;
    }
    qualitySwitchRef.current = null;
    setSwitchingQuality(false);
    setQuality(item.quality);
    toast.error("Could not switch quality", {
      description: playbackQuery.error.message,
    });
  }, [playbackQuery.error, item?.quality]);

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
    recoveryRef.current = { attempts: 0, lastTarget: 0 };
    recoveringRef.current = false;
    recoveryStartedAtRef.current = 0;
    setRecovery(null);
    setRecovering(false);
    setMediaIssue(null);
    return () => clearRecoveryTimer();
  }, [item?.id]);

  function clearRecoveryTimer() {
    if (recoveryTimerRef.current !== null) {
      window.clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }
  }

  const recoverStream = useCallback((resumeTicks?: number) => {
    const current = itemRef.current;
    if (!current) {
      return;
    }
    if (current.playbackMethod !== "hls") {
      setMediaIssue("codec");
      setRecovering(false);
      return;
    }

    const now = Date.now();
    if (recoveringRef.current) {
      // Ignore duplicate fatal events from the same failure, but allow the
      // next attempt once the restarted load has had a moment to run.
      if (now - recoveryStartedAtRef.current < RECOVERY_FATAL_GRACE_MS) {
        return;
      }
      recoveringRef.current = false;
      clearRecoveryTimer();
    }

    const video = videoRef.current;
    const videoTicks =
      video && Number.isFinite(video.currentTime) && video.currentTime > 0
        ? Math.round(video.currentTime * TICKS_PER_SECOND)
        : positionRef.current;
    const state = recoveryRef.current;
    if (state.attempts >= RECOVERY_SKIP_SECONDS.length) {
      setRecovering(false);
      setMediaIssue("stream");
      return;
    }

    // A stalled player can sit on the last playable fragment, so move ahead of
    // it. On repeated attempts the previous target also keeps the new segment
    // request from landing on the same corrupt keyframe.
    const baseTicks = Math.max(videoTicks, resumeTicks ?? 0, state.lastTarget);
    const skipSeconds = RECOVERY_SKIP_SECONDS[state.attempts] ?? 30;
    const durationTicks =
      video && Number.isFinite(video.duration)
        ? Math.round(video.duration * TICKS_PER_SECOND)
        : current.runtimeTicks;
    const wantedTicks = baseTicks + skipSeconds * TICKS_PER_SECOND;
    const targetTicks =
      durationTicks !== undefined && durationTicks > 0
        ? Math.min(wantedTicks, Math.max(0, durationTicks - TICKS_PER_SECOND))
        : wantedTicks;
    state.attempts += 1;
    state.lastTarget = targetTicks;
    recoveryStartedAtRef.current = now;
    recoveringRef.current = true;
    positionRef.current = targetTicks;
    setMediaIssue(null);
    setRecovering(true);
    // Recreate the HLS pipeline with an explicit start position. Reusing the
    // existing instance after a fatal media error can leave the element at 0,
    // so a fresh MediaSource is more reliable than startLoad() in place.
    setRecovery({ itemId: current.id, targetTicks, attempt: state.attempts });

    // If hls.js never emits another error and playback does not resume, keep
    // trying automatically with the next offset.
    clearRecoveryTimer();
    recoveryTimerRef.current = window.setTimeout(() => {
      recoveryTimerRef.current = null;
      if (!recoveringRef.current) {
        return;
      }
      recoveringRef.current = false;
      recoverStream();
    }, RECOVERY_RETRY_MS);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !item || item.playbackMethod !== "hls") {
      return;
    }

    const activeRecovery =
      recovery?.itemId === item.id ? recovery : undefined;
    // A quality switch starts the new transcode at the position the old stream
    // reached. The ref stays until consumed so the direct-play path can seek on
    // its own `loadedmetadata`.
    const pendingSwitch =
      qualitySwitchRef.current?.quality === item.quality
        ? qualitySwitchRef.current
        : undefined;
    const targetTicks = activeRecovery?.targetTicks ?? pendingSwitch?.ticks;
    const targetSeconds =
      targetTicks !== undefined ? targetTicks / TICKS_PER_SECOND : undefined;
    // A paused player stays paused across a quality switch; error recovery
    // always resumes.
    const autoplay = pendingSwitch ? !pendingSwitch.paused : true;
    if (pendingSwitch) {
      qualitySwitchRef.current = null;
    }

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = item.streamUrl;
      let disposed = false;
      const seekAndPlay = () => {
        if (disposed || targetSeconds === undefined) {
          return;
        }
        try {
          video.currentTime = targetSeconds;
        } catch {
          // Not seekable until metadata is ready.
        }
        if (autoplay) {
          void video.play().catch(() => {
            // The controls remain available if autoplay is blocked.
          });
        }
      };
      if (video.readyState >= 1) {
        seekAndPlay();
      } else {
        video.addEventListener("loadedmetadata", seekAndPlay, { once: true });
      }
      return () => {
        disposed = true;
        video.removeEventListener("loadedmetadata", seekAndPlay);
        video.removeAttribute("src");
        video.load();
      };
    }

    let cancelled = false;
    let hls: Hls | null = null;
    let networkRetries = 0;
    let mediaRetries = 0;
    void import("hls.js")
      .then(({ default: HlsConstructor }) => {
        if (cancelled) {
          return;
        }
        if (!HlsConstructor.isSupported()) {
          setRecovering(false);
          setMediaIssue("stream");
          return;
        }

        hls = new HlsConstructor(
          targetSeconds !== undefined
            ? { startPosition: targetSeconds }
            : undefined,
        );
        hlsRef.current = hls;
        hls.loadSource(item.streamUrl);
        hls.attachMedia(video);
        if (targetSeconds !== undefined && autoplay) {
          hls.on(HlsConstructor.Events.MANIFEST_PARSED, () => {
            void video.play().catch(() => {
              // The element may still be waiting for the first fragment.
            });
          });
        }
        hls.on(HlsConstructor.Events.ERROR, (_event, data) => {
          if (!data.fatal) {
            return;
          }

          // Transient network failures and media element errors can often be
          // retried in place before falling back to a new segment position.
          if (
            data.type === HlsConstructor.ErrorTypes.NETWORK_ERROR &&
            networkRetries < 2
          ) {
            networkRetries += 1;
            hls?.startLoad();
            return;
          }
          if (
            data.type === HlsConstructor.ErrorTypes.MEDIA_ERROR &&
            data.details !== HlsConstructor.ErrorDetails.BUFFER_STALLED_ERROR &&
            mediaRetries < 1
          ) {
            mediaRetries += 1;
            hls?.recoverMediaError();
            return;
          }

          if (data.type === HlsConstructor.ErrorTypes.MEDIA_ERROR) {
            // The first in-place media recovery did not help. Reset the
            // MediaSource again before seeking to a new segment position.
            hls?.recoverMediaError();
          }

          const failingTicks =
            typeof data.frag?.start === "number"
              ? Math.round(data.frag.start * TICKS_PER_SECOND)
              : undefined;
          recoverStream(failingTicks);
        });
      })
      .catch(() => {
        if (!cancelled) {
          recoverStream();
        }
      });

    return () => {
      cancelled = true;
      hls?.destroy();
      if (hlsRef.current === hls) {
        hlsRef.current = null;
      }
    };
  }, [
    item?.id,
    item?.streamUrl,
    item?.playbackMethod,
    recovery?.attempt,
    recoverStream,
  ]);

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
    if (!video) {
      return;
    }
    const pendingSwitch = qualitySwitchRef.current;
    if (pendingSwitch) {
      qualitySwitchRef.current = null;
      resumeAppliedRef.current = true;
      seekTo(video, pendingSwitch.ticks);
      positionRef.current = pendingSwitch.ticks;
      if (!pendingSwitch.paused) {
        void video.play().catch(() => {
          // The controls remain available if autoplay is blocked.
        });
      }
      return;
    }
    if (!item || resumeAppliedRef.current) {
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

  function handleQualityChange(value: string) {
    const next = value as PlaybackQuality;
    if (!item || next === quality || next === item.quality) {
      return;
    }
    const video = videoRef.current;
    const ticks =
      video && Number.isFinite(video.currentTime)
        ? Math.round(video.currentTime * TICKS_PER_SECOND)
        : positionRef.current;
    qualitySwitchRef.current = {
      quality: next,
      ticks,
      paused: video?.paused ?? true,
      previous: item,
    };
    setMediaIssue(null);
    setSwitchingQuality(true);
    setQuality(next);
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
      if (
        !recoveringRef.current &&
        recoveryRef.current.attempts > 0 &&
        positionRef.current >
          recoveryRef.current.lastTarget + 30 * TICKS_PER_SECOND
      ) {
        // Playback has been stable for a while; allow recovery at a later,
        // unrelated damaged section.
        recoveryRef.current.attempts = 0;
      }
    }
  }

  function handlePause() {
    const video = videoRef.current;
    if (video && !video.ended) {
      positionRef.current = Math.round(video.currentTime * TICKS_PER_SECOND);
      reportProgress(true);
    }
  }

  function retryPlayback() {
    recoveryRef.current.attempts = 0;
    recoveringRef.current = false;
    clearRecoveryTimer();
    setMediaIssue(null);
    recoverStream();
  }

  function handlePlaying() {
    recoveringRef.current = false;
    recoveryStartedAtRef.current = 0;
    clearRecoveryTimer();
    setRecovering(false);
  }

  function handleCanPlay() {
    const video = videoRef.current;
    if (!video || !recoveringRef.current) {
      return;
    }
    const targetSeconds = recoveryRef.current.lastTarget / TICKS_PER_SECOND;
    if (
      Number.isFinite(video.duration) &&
      Math.abs(video.currentTime - targetSeconds) > 2
    ) {
      try {
        video.currentTime = targetSeconds;
      } catch {
        // The new MediaSource is not seekable yet; hls.js will retry.
      }
    }
    void video.play().catch(() => {
      // The controls remain available if autoplay is blocked.
    });
  }

  function handleVideoError() {
    const current = itemRef.current;
    if (current?.playbackMethod === "hls") {
      recoverStream();
      return;
    }
    setMediaIssue("codec");
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

  const appliedQuality = item.qualities.find(
    (option) => option.id === item.quality,
  );

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
          <AlertTitle>
            {appliedQuality && item.quality !== "max"
              ? `Streaming at ${appliedQuality.label}`
              : "Transcoding for browser playback"}
          </AlertTitle>
          <AlertDescription>
            {appliedQuality && item.quality !== "max"
              ? `Jellyfin is transcoding this file to ${appliedQuality.detail} so it uses less bandwidth. Audio and video may take a moment to start.`
              : "Jellyfin is converting this file to a browser-compatible stream. Audio and video may take a moment to start."}
          </AlertDescription>
        </Alert>
      ) : null}

      {recovering ? (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>Reconnecting playback</AlertTitle>
          <AlertDescription>
            The stream stopped responding. Churn is resuming a few seconds
            ahead to skip the problem.
          </AlertDescription>
        </Alert>
      ) : null}

      {mediaIssue ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>
            {mediaIssue === "codec"
              ? "This video could not play in the browser"
              : "Playback was interrupted"}
          </AlertTitle>
          <AlertDescription>
            {mediaIssue === "codec"
              ? "The file may use a codec the browser cannot decode. Open Jellyfin to watch it there."
              : "Jellyfin stopped sending video, which usually means part of the file is damaged. Retry from the last position, or open Jellyfin."}
          </AlertDescription>
          <AlertAction>
            {mediaIssue === "stream" ? (
              <Button variant="outline" size="sm" onClick={retryPlayback}>
                Retry
              </Button>
            ) : (
              <Button asChild variant="outline" size="sm">
                <a
                  href="/api/services/jellyfin/open"
                  target="_blank"
                  rel="noreferrer"
                >
                  Open Jellyfin
                </a>
              </Button>
            )}
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
          onPlaying={handlePlaying}
          onCanPlay={handleCanPlay}
          onError={handleVideoError}
        />
      </Card>

      {item.qualities.length > 1 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">Quality</span>
          <Select value={quality} onValueChange={handleQualityChange}>
            <SelectTrigger
              size="sm"
              className="w-48"
              aria-label="Playback quality"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {item.qualities.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.label} — {option.detail}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {switchingQuality ? (
            <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <LoaderCircleIcon className="size-3.5 animate-spin" />
              Switching quality…
            </span>
          ) : appliedQuality && item.quality !== "max" ? (
            <span className="text-sm text-muted-foreground">
              Streaming at {appliedQuality.label} — {appliedQuality.detail}
            </span>
          ) : null}
        </div>
      ) : null}

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
    playbackMethod: item.playbackMethod,
  };
}

function seekTo(video: HTMLVideoElement, ticks: number): void {
  const seconds = ticks / TICKS_PER_SECOND;
  if (Number.isFinite(video.duration) && seconds >= video.duration - 1) {
    return;
  }
  try {
    video.currentTime = seconds;
  } catch {
    // Not seekable until the new media source has metadata.
  }
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
