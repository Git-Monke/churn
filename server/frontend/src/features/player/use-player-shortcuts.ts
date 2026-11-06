import { useEffect } from "react";

export type PlayerShortcut =
  | "toggle-play"
  | "seek-backward"
  | "seek-forward"
  | "fullscreen"
  | "mute"
  | "next";

/** The parts of a keydown the shortcut resolution needs, kept DOM-free for tests. */
export interface ShortcutKeyEvent {
  key: string;
  target?: unknown;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

interface ShortcutTarget {
  tagName?: string;
  isContentEditable?: boolean;
  /** `<input type>`; text-like inputs swallow the player shortcuts. */
  type?: string;
}

function asTarget(target: unknown): ShortcutTarget | undefined {
  return target !== null && typeof target === "object"
    ? (target as ShortcutTarget)
    : undefined;
}

const TEXT_INPUT_TYPES = new Set([
  "text",
  "search",
  "email",
  "password",
  "number",
  "tel",
  "url",
  "date",
  "datetime-local",
  "month",
  "time",
  "week",
]);

function isTextEntryTarget(target: ShortcutTarget | undefined): boolean {
  if (!target) {
    return false;
  }
  if (target.isContentEditable === true) {
    return true;
  }
  const tag = target.tagName?.toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") {
    return true;
  }
  if (tag === "INPUT") {
    const type = (target.type ?? "text").toLowerCase();
    // Checkboxes, radios and buttons keep their native space/arrow behaviour.
    return TEXT_INPUT_TYPES.has(type);
  }
  return false;
}

/**
 * Map a keydown to a player action. Returns `undefined` for anything the page
 * must not handle: modifier chords, text fields, the `<video>` element itself
 * (native shortcuts own it) and open menus/dialogs.
 */
export function resolvePlayerShortcut(
  event: ShortcutKeyEvent,
  overlayOpen = false,
): PlayerShortcut | undefined {
  if (overlayOpen || event.metaKey || event.ctrlKey || event.altKey) {
    return undefined;
  }
  const target = asTarget(event.target);
  if (isTextEntryTarget(target) || target?.tagName?.toUpperCase() === "VIDEO") {
    return undefined;
  }

  switch (event.key) {
    case " ":
    case "Spacebar":
    case "k":
    case "K":
      return "toggle-play";
    case "ArrowLeft":
      return "seek-backward";
    case "ArrowRight":
      return "seek-forward";
    case "f":
    case "F":
      return "fullscreen";
    case "m":
    case "M":
      return "mute";
    case "n":
    case "N":
      return "next";
    default:
      return undefined;
  }
}

const OVERLAY_SELECTOR = '[role="menu"][data-state="open"], [role="dialog"][data-state="open"]';

export interface PlayerShortcutHandlers {
  onTogglePlay: () => void;
  onSeek: (deltaSeconds: number) => void;
  onFullscreen: () => void;
  onMute: () => void;
  onNext: () => void;
}

/** Page-level player keys: Space/K, ←/→, F, M, N. */
export function usePlayerShortcuts(handlers: PlayerShortcutHandlers, enabled = true): void {
  const { onTogglePlay, onSeek, onFullscreen, onMute, onNext } = handlers;

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const listener = (event: KeyboardEvent) => {
      const overlayOpen = document.querySelector(OVERLAY_SELECTOR) !== null;
      const shortcut = resolvePlayerShortcut(event, overlayOpen);
      if (!shortcut) {
        return;
      }
      event.preventDefault();
      switch (shortcut) {
        case "toggle-play":
          onTogglePlay();
          break;
        case "seek-backward":
          onSeek(-10);
          break;
        case "seek-forward":
          onSeek(10);
          break;
        case "fullscreen":
          onFullscreen();
          break;
        case "mute":
          onMute();
          break;
        case "next":
          onNext();
          break;
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [enabled, onTogglePlay, onSeek, onFullscreen, onMute, onNext]);
}
