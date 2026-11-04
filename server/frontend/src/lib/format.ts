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
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
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
