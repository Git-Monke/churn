export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }
  if (bytes < 1024 ** 2) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  if (bytes < 1024 ** 3) {
    return `${Math.round(bytes / 1024 ** 2)} MB`;
  }
  if (bytes < 1024 ** 4) {
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  }
  if (bytes < 1024 ** 5) {
    return `${(bytes / 1024 ** 4).toFixed(1)} TB`;
  }
  return `${(bytes / 1024 ** 5).toFixed(1)} PB`;
}

export function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond < 1024) {
    return `${Math.round(bytesPerSecond)} B/s`;
  }
  if (bytesPerSecond < 1024 ** 2) {
    return `${Math.max(1, Math.round(bytesPerSecond / 1024))} KB/s`;
  }
  if (bytesPerSecond < 1024 ** 3) {
    return `${(bytesPerSecond / 1024 ** 2).toFixed(1)} MB/s`;
  }
  return `${(bytesPerSecond / 1024 ** 3).toFixed(1)} GB/s`;
}

/** `3.4 GB / 8.1 GB`, or just the total when the downloaded amount is unknown. */
export function formatDownloaded(
  sizeBytes: number | undefined,
  sizeLeftBytes: number | undefined,
): string | undefined {
  if (sizeBytes === undefined) {
    return undefined;
  }
  if (sizeLeftBytes === undefined) {
    return formatBytes(sizeBytes);
  }
  return `${formatBytes(Math.max(0, sizeBytes - sizeLeftBytes))} / ${formatBytes(sizeBytes)}`;
}

export function formatEta(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

/** `Oct 9, 2009` — episode air dates in the season list. */
export function formatAirDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

/**
 * A calendar date (`2009-04-16`, or a Jellyfin timestamp of
 * `2009-04-16T00:00:00.0000000Z`) shown as written. `formatAirDate` shifts those
 * into the viewer's timezone, which turns a midnight UTC premiere into the
 * previous day west of Greenwich.
 */
export function formatCalendarDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  const date = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

/** `1h 32m`, `45m` or `2h` — used by the title header metadata row. */
export function formatRuntime(minutes: number): string {
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}

/**
 * Coarse "when was this" wording for the picker footer:
 * `just now`, `12 minutes ago`, `20 hours ago`, `3 days ago`.
 */
export function formatRelativeAge(value: string, now = Date.now()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "just now";
  }
  const minutes = Math.max(0, Math.round((now - date.getTime()) / 60_000));
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  }
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/**
 * Rounded ETA wording used by the title header's downloading state:
 * `about 20 min`, `about 1 hr 30 min`, `about 2 hr`, `a few seconds`.
 */
export function formatMinutesAbout(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0) {
    return "a few seconds";
  }
  if (minutes < 1) {
    return "a few seconds";
  }
  if (minutes < 60) {
    return `about ${Math.round(minutes)} min`;
  }
  const hours = Math.floor(minutes / 60);
  const remainder = Math.round(minutes % 60);
  if (remainder >= 5 && hours < 3) {
    return `about ${hours} hr ${remainder} min`;
  }
  return `about ${remainder >= 30 ? hours + 1 : hours} hr`;
}

/**
 * Parse the relative time left strings qBittorrent and the arrs report
 * (`1h 32m`, `20m`, `45s`, `2d 4h`, `01:30:00`) into rounded minutes.
 */
export function minutesFromTimeLeft(value: string | undefined): number | undefined {
  const text = value?.trim();
  if (!text) {
    return undefined;
  }
  const clock = text.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (clock) {
    const first = Number(clock[1]);
    const second = Number(clock[2]);
    const third = clock[3] === undefined ? undefined : Number(clock[3]);
    // `mm:ss` when no third group is present, otherwise `hh:mm:ss`.
    return third === undefined ? first + second / 60 : first * 60 + second + third / 60;
  }
  const parts = [...text.matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/gi)];
  if (parts.length === 0) {
    return undefined;
  }
  let minutes = 0;
  for (const part of parts) {
    const amount = Number(part[1]);
    switch ((part[2] ?? "").toLowerCase()) {
      case "d":
        minutes += amount * 24 * 60;
        break;
      case "h":
        minutes += amount * 60;
        break;
      case "m":
        minutes += amount;
        break;
      case "s":
        minutes += amount / 60;
        break;
      default:
        break;
    }
  }
  return minutes;
}

/** `about 20 min` from a qBittorrent/arr `timeLeft` string, when parseable. */
export function formatTimeLeftAbout(value: string | undefined): string | undefined {
  const minutes = minutesFromTimeLeft(value);
  return minutes === undefined ? undefined : formatMinutesAbout(minutes);
}

/** `about 20 min` from an absolute completion timestamp, when parseable. */
export function formatCompletionAbout(
  value: string | undefined,
  now = Date.now(),
): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return formatMinutesAbout(Math.max(0, (date.getTime() - now) / 60_000));
}

/** `2 years old` style age for a search result's publish date. */
export function formatReleaseAge(hours: number): string {
  if (hours < 1) {
    return "< 1 hour old";
  }
  if (hours < 24) {
    const rounded = Math.round(hours);
    return `${rounded} ${rounded === 1 ? "hour" : "hours"} old`;
  }
  const days = Math.round(hours / 24);
  if (days < 30) {
    return `${days} ${days === 1 ? "day" : "days"} old`;
  }
  const months = Math.round(days / 30);
  if (months < 12) {
    return `${months} ${months === 1 ? "month" : "months"} old`;
  }
  const years = Math.round(months / 12);
  return `${years} ${years === 1 ? "year" : "years"} old`;
}
