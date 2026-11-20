import { MoreHorizontalIcon, RotateCcwIcon } from "lucide-react";

import type {
  PlaybackQuality,
  PlaybackQualityOption,
  PlaybackSubtitle,
} from "@/api/types";
import { subtitleLabel } from "@/features/player/playback-meta";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface PlaybackSettingsMenuProps {
  qualities: PlaybackQualityOption[];
  quality: PlaybackQuality;
  onQualityChange: (quality: PlaybackQuality) => void;
  /** Text tracks for this file; the section is omitted when empty. */
  subtitles: PlaybackSubtitle[];
  /** Selected subtitle stream index, or `null` for off. */
  subtitle: number | null;
  onSubtitleChange: (index: number | null) => void;
  /** Episodes only; the menu omits the item for movies. */
  autoplay?: boolean;
  onAutoplayChange?: (enabled: boolean) => void;
  onStartOver: () => void;
  /** A quality switch is in flight; radios stay usable but show the wait. */
  switchingQuality?: boolean;
  portalContainer?: HTMLElement | null;
}

/**
 * The player's only settings surface. Quality and the autoplay preference live
 * here so the frame stays clean; both are wired to the page's existing logic.
 */
export function PlaybackSettingsMenu({
  qualities,
  quality,
  onQualityChange,
  subtitles,
  subtitle,
  onSubtitleChange,
  autoplay,
  onAutoplayChange,
  onStartOver,
  switchingQuality = false,
  portalContainer,
}: PlaybackSettingsMenuProps) {
  const tiers = qualities.filter((option) => option.id !== "max");
  const showAutoplay = autoplay !== undefined && onAutoplayChange !== undefined;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-12"
          aria-label="Playback settings"
        >
          <MoreHorizontalIcon className="size-5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56" portalContainer={portalContainer}>
        {tiers.length > 0 ? (
          <>
            <DropdownMenuLabel>
              {switchingQuality ? "Quality · switching…" : "Quality"}
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={quality}
              onValueChange={(value) => onQualityChange(value as PlaybackQuality)}
            >
              <DropdownMenuRadioItem value="max">Auto</DropdownMenuRadioItem>
              {tiers.map((option) => (
                <DropdownMenuRadioItem key={option.id} value={option.id}>
                  {option.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {subtitles.length > 0 ? (
          <>
            <DropdownMenuLabel>Subtitles</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={subtitle === null ? "off" : String(subtitle)}
              onValueChange={(value) =>
                onSubtitleChange(value === "off" ? null : Number(value))
              }
            >
              <DropdownMenuRadioItem value="off">Off</DropdownMenuRadioItem>
              {subtitles.map((track) => (
                <DropdownMenuRadioItem key={track.index} value={String(track.index)}>
                  {subtitleLabel(track)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {showAutoplay ? (
          <>
            <DropdownMenuCheckboxItem
              checked={autoplay}
              onCheckedChange={(checked) => onAutoplayChange(checked === true)}
            >
              Autoplay next episode
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem onSelect={onStartOver}>
          <RotateCcwIcon />
          Start from beginning
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
