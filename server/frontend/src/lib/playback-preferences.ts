import type { PlaybackQuality } from "@/api/types";

const QUALITY_KEY = "churn:play:quality";
const AUTOPLAY_KEY = "churn:play:autoplay";
const QUALITIES: readonly PlaybackQuality[] = ["max", "high", "medium", "low"];

function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function readPlaybackQuality(): PlaybackQuality {
  try {
    const value = storage()?.getItem(QUALITY_KEY);
    return QUALITIES.find((quality) => quality === value) ?? "max";
  } catch {
    return "max";
  }
}

export function writePlaybackQuality(quality: PlaybackQuality): void {
  try {
    storage()?.setItem(QUALITY_KEY, quality);
  } catch {
    // Preferences are optional; playback still works without storage.
  }
}

export function readAutoplay(): boolean {
  try {
    return storage()?.getItem(AUTOPLAY_KEY) !== "false";
  } catch {
    return true;
  }
}

export function writeAutoplay(enabled: boolean): void {
  try {
    storage()?.setItem(AUTOPLAY_KEY, String(enabled));
  } catch {
    // Preferences are optional; autoplay still works without storage.
  }
}
