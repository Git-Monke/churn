import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type Hls from "hls.js";
import { toast } from "sonner";
import { ChevronLeftIcon, CircleAlertIcon } from "lucide-react";

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
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  EndedOverlay,
  PlaybackErrorOverlay,
  SkipIntroButton,
} from "@/features/player/PlayerOverlays";
import { PlaybackSettingsMenu } from "@/features/player/PlaybackSettingsMenu";
import { PlaybackTitleRow } from "@/features/player/PlaybackTitleRow";
import { UpNextCard } from "@/features/player/UpNextCard";
import {
  resumeStartSeconds,
  TICKS_PER_SECOND,
  upNextTriggerSeconds,
  UP_NEXT_COUNTDOWN_SECONDS,
} from "@/features/player/playback-meta";
import { usePlayerShortcuts } from "@/features/player/use-player-shortcuts";
import {
  playHash,
  replaceHash,
  showHash,
  type ShowReturnContext,
} from "@/hooks/use-hash-route";
import {
  readAutoplay,
  readPlaybackQuality,
  writeAutoplay,
  writePlaybackQuality,
} from "@/lib/playback-preferences";
import { isInsideSegment } from "@/lib/playback-segments";

// One report per second keeps Jellyfin's resume point within a second of the
// playhead, so a killed tab or crashed browser does not lose the last minutes
// of watching. Requests are fire-and-forget; nothing here blocks the video.
const REPORT_INTERVAL_MS = 1_000;
// Scrubbing emits a seek per preview frame. Wait for the playhead to settle
// before telling Jellyfin, so one drag costs one report instead of dozens.
const SEEK_REPORT_DEBOUNCE_MS = 500;
// A timeupdate gap larger than this means the user jumped rather than played
// through the trigger naturally. Autoplay only arms on natural playback.
const NEXT_EPISODE_NATURAL_GAP_SECONDS = 2;
const NEXT_EPISODE_SEEK_GRACE_MS = 1_500;
// Advance further each time so the new segment request makes Jellyfin restart
// its transcode past a damaged section instead of on the same bad keyframe.
const RECOVERY_SKIP_SECONDS = [5, 15, 30];
const RECOVERY_RETRY_MS = 12_000;
const RECOVERY_FATAL_GRACE_MS = 1_500;

type MediaIssue = "codec" | "stream";

/** Why a progress report is going out; periodic ticks are the only droppable ones. */
type ProgressReportReason = "interval" | "pause" | "seek";

interface NextPromptState {
  remaining: number;
  auto: boolean;
  deadline?: number;
}

export function PlayPage({
  id,
  from,
  restart = false,
}: {
  id: string;
  from?: ShowReturnContext;
  /** Start at 0:00 instead of the saved position; autoplay sets this. */
  restart?: boolean;
}) {
  const queryClient = useQueryClient();
  const [quality, setQuality] = useState<PlaybackQuality>(readPlaybackQuality);
  const [autoplay, setAutoplay] = useState(readAutoplay);
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
  const frameRef = useRef<HTMLDivElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const itemRef = useRef<PlaybackItem | undefined>(undefined);
  const positionRef = useRef(0);
  const startedRef = useRef(false);
  const stoppedRef = useRef(false);
  const resumeAppliedRef = useRef(false);
  // Last position handed to Jellyfin, so a stalled playhead costs no requests.
  const lastReportRef = useRef<{ ticks: number; paused: boolean } | null>(null);
  const progressInFlightRef = useRef(0);
  const seekReportTimerRef = useRef<number | null>(null);
  // Set when a quality switch is requested; the next stream starts here.
  const qualitySwitchRef = useRef<{
    quality: PlaybackQuality;
    ticks: number;
    paused: boolean;
    previous?: PlaybackItem;
  } | null>(null);
  const [switchingQuality, setSwitchingQuality] = useState(false);
  const [showSkipIntro, setShowSkipIntro] = useState(false);
  const [nextPrompt, setNextPrompt] = useState<NextPromptState | null>(null);
  const [mediaIssue, setMediaIssue] = useState<MediaIssue | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [ended, setEnded] = useState(false);
  const [recovery, setRecovery] = useState<{
    itemId: string;
    targetTicks: number;
    attempt: number;
  } | null>(null);
  const recoveryRef = useRef({ attempts: 0, lastTarget: 0 });
  const recoveringRef = useRef(false);
  const recoveryStartedAtRef = useRef(0);
  const recoveryTimerRef = useRef<number | null>(null);
  const promptShownRef = useRef(false);
  const promptDismissedRef = useRef(false);
  const advancingRef = useRef(false);
  const autoArmedRef = useRef(false);
  const lastTimeRef = useRef(0);
  const seekingRef = useRef(false);
  const seekedRef = useRef(false);
  const lastSeekAtRef = useRef(0);
  const advanceNextRef = useRef<() => void>(() => {});

  itemRef.current = item;
  advanceNextRef.current = () => advanceToNext(true);

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
    writePlaybackQuality(item.quality);
    toast.error("Could not switch quality", {
      description: playbackQuery.error.message,
    });
  }, [playbackQuery.error, item?.quality]);

  // A remembered tier may not be available for this file. Keep the preference,
  // but show the tier the backend actually applied.
  useEffect(() => {
    if (!item || qualitySwitchRef.current) {
      return;
    }
    if (!item.qualities.some((option) => option.id === quality)) {
      setQuality(item.quality);
    }
  }, [item?.quality, item?.qualities, quality]);

  // The end-of-file fallback has no media clock left, so count down on wall
  // time. The credits path is driven by timeupdate instead.
  useEffect(() => {
    if (!nextPrompt?.auto || nextPrompt.deadline === undefined) {
      return;
    }
    const deadline = nextPrompt.deadline;
    const tick = () => {
      const remaining = Math.max(
        0,
        Math.ceil((deadline - Date.now()) / 1000),
      );
      if (remaining <= 0) {
        advanceNextRef.current();
        return;
      }
      setNextPrompt((previous) =>
        previous?.deadline === deadline && previous.remaining !== remaining
          ? { ...previous, remaining }
          : previous,
      );
    };
    tick();
    const interval = window.setInterval(tick, 250);
    return () => window.clearInterval(interval);
  }, [nextPrompt?.auto, nextPrompt?.deadline]);

  const reportProgress = useCallback(
    (isPaused: boolean, reason: ProgressReportReason = "interval") => {
      const current = itemRef.current;
      if (!current || stoppedRef.current) {
        return;
      }
      const ticks = positionRef.current;
      if (reason === "interval") {
        // A stalled stream repeats the same position, and a slow round trip
        // must not build a queue of reports that are already stale.
        if (progressInFlightRef.current > 0) {
          return;
        }
        const last = lastReportRef.current;
        if (last && last.ticks === ticks && last.paused === isPaused) {
          return;
        }
      }
      lastReportRef.current = { ticks, paused: isPaused };
      progressInFlightRef.current += 1;
      void reportPlaybackProgress(current.id, reportBody(current, ticks, isPaused))
        .catch(() => {
          // Reporting is best-effort; the video keeps playing.
        })
        .finally(() => {
          progressInFlightRef.current -= 1;
        });
    },
    [],
  );

  function clearSeekReport(): void {
    if (seekReportTimerRef.current !== null) {
      window.clearTimeout(seekReportTimerRef.current);
      seekReportTimerRef.current = null;
    }
  }

  /**
   * The playhead right now, preferring the media clock over the last
   * `timeupdate` so a seek or an unmount reports the position the user chose.
   */
  function currentTicks(): number {
    const video = videoRef.current;
    return video && Number.isFinite(video.currentTime) && video.currentTime > 0
      ? Math.round(video.currentTime * TICKS_PER_SECOND)
      : positionRef.current;
  }

  /** Report the position a moment after the last seek event of a scrub. */
  const scheduleSeekReport = useCallback(() => {
    clearSeekReport();
    seekReportTimerRef.current = window.setTimeout(() => {
      seekReportTimerRef.current = null;
      positionRef.current = currentTicks();
      reportProgress(videoRef.current?.paused ?? true, "seek");
    }, SEEK_REPORT_DEBOUNCE_MS);
  }, [reportProgress]);

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
          void queryClient.invalidateQueries({ queryKey: ["resume"] });
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
      // A scrub in progress reports preview positions; the settled position
      // goes out from `handleSeeked` instead.
      if (video && !video.paused && !video.ended && !seekingRef.current) {
        reportProgress(false);
      }
    }, REPORT_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [reportProgress]);

  useEffect(() => {
    lastReportRef.current = null;
    progressInFlightRef.current = 0;
    clearSeekReport();
    recoveryRef.current = { attempts: 0, lastTarget: 0 };
    recoveringRef.current = false;
    recoveryStartedAtRef.current = 0;
    setRecovery(null);
    setRecovering(false);
    setMediaIssue(null);
    setShowSkipIntro(false);
    setNextPrompt(null);
    setEnded(false);
    promptShownRef.current = false;
    promptDismissedRef.current = false;
    advancingRef.current = false;
    autoArmedRef.current = false;
    lastTimeRef.current = 0;
    seekingRef.current = false;
    seekedRef.current = false;
    lastSeekAtRef.current = 0;
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
        if (disposed) {
          return;
        }
        if (targetSeconds !== undefined) {
          try {
            video.currentTime = targetSeconds;
          } catch {
            // Not seekable until metadata is ready.
          }
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
        if (autoplay) {
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
      // A pending seek report is superseded by this stop.
      clearSeekReport();
      sendStopBeacon(currentItem, currentTicks());
    };
    const stopOnUnmount = () => {
      const currentItem = itemRef.current;
      if (!currentItem || !startedRef.current || stoppedRef.current) {
        return;
      }
      stoppedRef.current = true;
      clearSeekReport();
      sendStopKeepalive(currentItem, currentTicks());
    };

    window.addEventListener("pagehide", stopFromPageHide);
    return () => {
      window.removeEventListener("pagehide", stopFromPageHide);
      stopOnUnmount();
      clearSeekReport();
      const currentItem = itemRef.current;
      if (currentItem) {
        void queryClient.invalidateQueries({ queryKey: ["playback", currentItem.id] });
        void queryClient.invalidateQueries({ queryKey: ["resume"] });
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
    const resumeSeconds = resumeStartSeconds(item, {
      restart,
      durationSec: video.duration,
    });
    if (resumeSeconds > 0) {
      video.currentTime = resumeSeconds;
      positionRef.current = Math.round(resumeSeconds * TICKS_PER_SECOND);
    } else {
      // Autoplay and rewatching always report the new episode from 0:00.
      positionRef.current = 0;
    }
    // The user already chose this item; start it as soon as the source is
    // ready. Browsers may still reject this if their autoplay policy requires
    // another gesture, in which case the native controls remain available.
    void video.play().catch(() => {});
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
    writePlaybackQuality(next);
  }

  function handleAutoplayChange(enabled: boolean) {
    setAutoplay(enabled);
    writeAutoplay(enabled);
    if (!enabled) {
      // Turning autoplay off cancels the current countdown; re-enabling must
      // not resurrect it. Play next remains available.
      autoArmedRef.current = false;
    }
    setNextPrompt((previous) => {
      if (!previous) {
        return previous;
      }
      if (!enabled) {
        return { ...previous, auto: false, remaining: 0, deadline: undefined };
      }
      return previous;
    });
  }

  function handleSeeking() {
    seekingRef.current = true;
    seekedRef.current = false;
    lastSeekAtRef.current = Date.now();
    autoArmedRef.current = false;
    setNextPrompt((previous) =>
      previous ? { ...previous, auto: false, remaining: 0, deadline: undefined } : previous,
    );
  }

  function handleSeeked() {
    seekingRef.current = false;
    seekedRef.current = true;
    // Persist the jump as soon as the user stops dragging, instead of waiting
    // for the next tick or for the page to close.
    scheduleSeekReport();
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
      const previousTime = lastTimeRef.current;
      positionRef.current = Math.round(video.currentTime * TICKS_PER_SECOND);
      const current = itemRef.current;
      const intro = current?.segments?.intro;
      setShowSkipIntro(
        !video.ended &&
          !recoveringRef.current &&
          !mediaIssue &&
          intro !== undefined &&
          isInsideSegment(intro, video.currentTime),
      );

      // The credits marker or the last 20 seconds, whichever comes first.
      const triggerAt = current?.nextEpisode
        ? upNextTriggerSeconds({
            durationSec: Number.isFinite(video.duration) ? video.duration : undefined,
            outro: current.segments?.outro,
          })
        : undefined;
      if (
        current?.nextEpisode &&
        triggerAt !== undefined &&
        !video.ended &&
        !recoveringRef.current &&
        !mediaIssue &&
        !switchingQuality &&
        !promptDismissedRef.current &&
        !advancingRef.current
      ) {
        const advanceAt = triggerAt + UP_NEXT_COUNTDOWN_SECONDS;
        if (video.currentTime >= triggerAt) {
          if (!promptShownRef.current) {
            promptShownRef.current = true;
            // Only count down when playback reached the trigger naturally.
            // Scrubbing into the credits shows a static Play next prompt.
            autoArmedRef.current =
              !seekingRef.current &&
              !seekedRef.current &&
              previousTime < triggerAt &&
              video.currentTime - previousTime <=
                NEXT_EPISODE_NATURAL_GAP_SECONDS;
          }
          const auto = autoArmedRef.current && autoplay;
          if (auto && video.currentTime >= advanceAt) {
            advanceToNext(true);
          } else {
            const remaining = auto
              ? Math.max(1, Math.ceil(advanceAt - video.currentTime))
              : 0;
            setNextPrompt((previous) =>
              previous?.remaining === remaining && previous.auto === auto
                ? previous
                : { remaining, auto },
            );
          }
        } else if (promptShownRef.current) {
          // Seeking back before the credits re-arms the prompt.
          promptShownRef.current = false;
          autoArmedRef.current = false;
          setNextPrompt(null);
        }
      }

      lastTimeRef.current = video.currentTime;
      seekedRef.current = false;

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
      reportProgress(true, "pause");
    }
  }

  /**
   * Jump to the next episode. `markWatched` reports the whole runtime so
   * Jellyfin marks the finished episode played; an explicit mid-episode skip
   * reports the current position instead.
   */
  function advanceToNext(markWatched: boolean) {
    const current = itemRef.current;
    const next = current?.nextEpisode;
    if (!current || !next || advancingRef.current) {
      return;
    }
    advancingRef.current = true;
    promptDismissedRef.current = true;
    promptShownRef.current = true;
    setNextPrompt(null);

    const video = videoRef.current;
    const durationTicks = markWatched
      ? video && Number.isFinite(video.duration) && video.duration > 0
        ? Math.round(video.duration * TICKS_PER_SECOND)
        : (current.runtimeTicks ?? positionRef.current)
      : positionRef.current;
    stopPlayback(durationTicks);

    const nextFrom = from
      ? { ...from, season: next.seasonNumber }
      : current.seriesId
        ? {
            source: "jellyfin" as const,
            id: current.seriesId,
            season: next.seasonNumber,
          }
        : undefined;
    // Autoplay (and Play now) always starts the next episode at 0:00, even when
    // it still has progress from an earlier viewing.
    replaceHash(playHash(next.id, nextFrom, markWatched));
  }

  function dismissNextPrompt() {
    promptDismissedRef.current = true;
    setNextPrompt(null);
  }

  /** Start over from the first frame; the report already covers this session. */
  function startFromBeginning() {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    try {
      video.currentTime = 0;
    } catch {
      // Not seekable until metadata is ready.
    }
    positionRef.current = 0;
    lastTimeRef.current = 0;
    promptShownRef.current = false;
    promptDismissedRef.current = false;
    autoArmedRef.current = false;
    setNextPrompt(null);
  }

  /** Replay a finished movie or final episode. */
  function watchAgain() {
    setEnded(false);
    startFromBeginning();
    void videoRef.current?.play().catch(() => {
      // The native controls remain available if autoplay is blocked.
    });
  }

  function skipIntro() {
    const intro = itemRef.current?.segments?.intro;
    const video = videoRef.current;
    if (!intro || !video) {
      return;
    }
    // The intro range may extend past the last playable frame on a damaged
    // file; keep the seek just inside the duration in that case.
    const duration = video.duration;
    const target =
      Number.isFinite(duration) && duration > 0.25
        ? Math.min(intro.endSec, duration - 0.25)
        : intro.endSec;
    video.currentTime = target;
    positionRef.current = Math.round(target * TICKS_PER_SECOND);
    setShowSkipIntro(false);
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

    const current = itemRef.current;
    if (
      !current?.nextEpisode ||
      promptDismissedRef.current ||
      advancingRef.current
    ) {
      setEnded(true);
      return;
    }
    if (promptShownRef.current) {
      if (autoplay && autoArmedRef.current) {
        advanceToNext(true);
      }
      return;
    }

    const recentlySeeked =
      Date.now() - lastSeekAtRef.current < NEXT_EPISODE_SEEK_GRACE_MS;
    const auto = autoplay && !recentlySeeked;
    autoArmedRef.current = auto;
    promptShownRef.current = true;
    setNextPrompt({
      remaining: auto ? UP_NEXT_COUNTDOWN_SECONDS : 0,
      auto,
      ...(auto
        ? { deadline: Date.now() + UP_NEXT_COUNTDOWN_SECONDS * 1000 }
        : {}),
    });
  }

  function togglePlay() {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    if (video.paused) {
      void video.play().catch(() => {
        // The native controls remain available if autoplay is blocked.
      });
    } else {
      video.pause();
    }
  }

  function seekBy(deltaSeconds: number) {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    const duration = Number.isFinite(video.duration) ? video.duration : undefined;
    const target = Math.max(0, Math.min(video.currentTime + deltaSeconds, duration ?? Infinity));
    try {
      video.currentTime = target;
      positionRef.current = Math.round(target * TICKS_PER_SECOND);
    } catch {
      // Not seekable until metadata is ready.
    }
  }

  function toggleFullscreen() {
    const frame = frameRef.current;
    if (!frame) {
      return;
    }
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
      return;
    }
    void frame.requestFullscreen().catch(() => {
      // Fullscreen can be blocked by browser policy; the native control works.
    });
  }

  function toggleMute() {
    const video = videoRef.current;
    if (video) {
      video.muted = !video.muted;
    }
  }

  usePlayerShortcuts(
    {
      onTogglePlay: togglePlay,
      onSeek: seekBy,
      onFullscreen: toggleFullscreen,
      onMute: toggleMute,
      onNext: () => advanceToNext(false),
    },
    item !== undefined,
  );

  // Return to the show the episode came from instead of dumping the user in the
  // library. Movies and context-less deep links keep the library link.
  const backHref = from ? showHash(from.source, from.id, from.season) : "#/library";
  const backLabel = item?.seriesName
    ? `Back to ${item.seriesName}`
    : from
      ? from.season !== undefined
        ? `Back to season ${from.season}`
        : "Back to show"
      : "Back to Library";

  if (playbackQuery.isLoading) {
    return <PlaybackLoading />;
  }

  if (playbackQuery.error && !playbackQuery.data) {
    return (
      <PlaybackMessage
        title="Could not load this video"
        detail={playbackQuery.error.message}
        backHref={backHref}
        backLabel={backLabel}
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
        backHref={backHref}
        backLabel={backLabel}
      />
    );
  }

  const showUpNext = nextPrompt !== null && item.nextEpisode !== undefined;

  return (
    <div className="flex flex-col gap-5">
      <a
        href={backHref}
        className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeftIcon className="size-4" aria-hidden />
        {backLabel}
      </a>
      <div
        ref={frameRef}
        className="relative mx-auto aspect-video w-full max-w-[calc((100dvh_-_19rem)*16/9)] overflow-hidden bg-black"
      >
        <video
          ref={videoRef}
          className="size-full bg-black"
          controls
          playsInline
          preload="metadata"
          poster={item.imageUrl}
          src={item.playbackMethod === "direct" ? item.streamUrl : undefined}
          onLoadedMetadata={handleLoadedMetadata}
          onPlay={handlePlay}
          onPause={handlePause}
          onSeeking={handleSeeking}
          onSeeked={handleSeeked}
          onTimeUpdate={handleTimeUpdate}
          onEnded={handleEnded}
          onPlaying={handlePlaying}
          onCanPlay={handleCanPlay}
          onError={handleVideoError}
        />
        {mediaIssue ? <PlaybackErrorOverlay onRetry={retryPlayback} /> : null}
        {!mediaIssue && ended ? (
          <EndedOverlay
            onWatchAgain={watchAgain}
            backHref={backHref}
            backLabel={backLabel}
          />
        ) : null}
        {!mediaIssue && !ended && !showUpNext && showSkipIntro ? (
          <SkipIntroButton onClick={skipIntro} />
        ) : null}
        {!mediaIssue && !ended && nextPrompt && item.nextEpisode ? (
          <UpNextCard
            episode={item.nextEpisode}
            thumbnailUrl={`/api/library/images/${encodeURIComponent(item.nextEpisode.id)}`}
            remainingSeconds={
              nextPrompt.auto ? Math.max(1, nextPrompt.remaining) : undefined
            }
            countdownSeconds={UP_NEXT_COUNTDOWN_SECONDS}
            onPlayNow={() => advanceToNext(true)}
            onCancel={dismissNextPrompt}
          />
        ) : null}
      </div>

      <PlaybackTitleRow
        item={item}
        from={from}
        onNext={item.nextEpisode ? () => advanceToNext(false) : undefined}
        settings={
          <PlaybackSettingsMenu
            qualities={item.qualities}
            quality={quality}
            onQualityChange={handleQualityChange}
            autoplay={item.type === "Episode" ? autoplay : undefined}
            onAutoplayChange={
              item.type === "Episode" ? handleAutoplayChange : undefined
            }
            onStartOver={startFromBeginning}
            switchingQuality={switchingQuality}
          />
        }
      />
    </div>
  );

}

function PlaybackMessage({
  title,
  detail,
  backHref = "#/library",
  backLabel = "Back to Library",
}: {
  title: string;
  detail: string;
  backHref?: string;
  backLabel?: string;
}) {
  return (
    <div className="flex flex-col gap-6">
      <a
        href={backHref}
        className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeftIcon className="size-4" />
        {backLabel}
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
    <div className="flex flex-col gap-5">
      <Skeleton className="h-5 w-44" />
      <Skeleton className="mx-auto aspect-video w-full max-w-[calc((100dvh_-_19rem)*16/9)]" />
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div className="flex min-w-0 flex-[999_1_480px] flex-col gap-2.5">
          <Skeleton className="h-8 w-72" />
          <Skeleton className="h-4 w-64" />
          <Skeleton className="h-4 w-full max-w-[72ch]" />
        </div>
        <div className="flex flex-none items-center gap-2.5">
          <Skeleton className="h-12 w-48" />
          <Skeleton className="size-12" />
        </div>
      </div>
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
