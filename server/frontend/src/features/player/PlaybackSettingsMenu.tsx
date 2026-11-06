import { MoreHorizontalIcon, RotateCcwIcon } from "lucide-react";

import type { PlaybackQuality, PlaybackQualityOption } from "@/api/types";
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
  /** Episodes only; the menu omits the item for movies. */
  autoplay?: boolean;
  onAutoplayChange?: (enabled: boolean) => void;
  onStartOver: () => void;
  /** A quality switch is in flight; radios stay usable but show the wait. */
  switchingQuality?: boolean;
}

/**
 * The player's only settings surface. Quality and the autoplay preference live
 * here so the frame stays clean; both are wired to the page's existing logic.
 */
export function PlaybackSettingsMenu({
  qualities,
  quality,
  onQualityChange,
  autoplay,
  onAutoplayChange,
  onStartOver,
  switchingQuality = false,
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
      <DropdownMenuContent align="end" className="w-56">
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
