import { useEffect, useMemo, useState } from "react";

import type { LibraryEntry } from "@/features/library/library-entries";

const SCAN_TIMEOUT_MS = 2 * 60_000;
const SCAN_STARTS_KEY = "churn:library-scan-started";

type ScanStarts = Record<string, number>;

/**
 * Promote long-running scan cards to a failed state without losing the scan
 * start time across a reload. Once Jellyfin returns the item, the entry stops
 * scanning and its saved timestamp is cleared.
 */
export function useLibraryScanState(entries: LibraryEntry[]): LibraryEntry[] {
  const [starts, setStarts] = useState<ScanStarts>(readScanStarts);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const presentKeys = new Set(entries.map((entry) => entry.key));
    setStarts((current) => {
      const next = { ...current };
      let changed = false;

      for (const entry of entries) {
        if (entry.status === "scanning") {
          if (next[entry.key] === undefined) {
            next[entry.key] = Date.now();
            changed = true;
          }
        } else if (next[entry.key] !== undefined) {
          delete next[entry.key];
          changed = true;
        }
      }

      for (const key of Object.keys(next)) {
        if (!presentKeys.has(key)) {
          delete next[key];
          changed = true;
        }
      }

      if (!changed) {
        return current;
      }
      writeScanStarts(next);
      return next;
    });
  }, [entries]);

  const adjusted = useMemo(
    () =>
      entries.map((entry): LibraryEntry => {
        if (entry.status !== "scanning") {
          return entry;
        }
        const startedAt = starts[entry.key] ?? now;
        return now - startedAt >= SCAN_TIMEOUT_MS
          ? { ...entry, status: "scan_failed" }
          : entry;
      }),
    [entries, starts, now],
  );

  const scanning = adjusted.some((entry) => entry.status === "scanning");
  useEffect(() => {
    if (!scanning) {
      return;
    }
    const interval = window.setInterval(() => {
      setNow(Date.now());
    }, 1_000);
    return () => window.clearInterval(interval);
  }, [scanning]);

  return adjusted;
}

function readScanStarts(): ScanStarts {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = window.sessionStorage.getItem(SCAN_STARTS_KEY);
    if (!raw) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const starts: ScanStarts = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        starts[key] = value;
      }
    }
    return starts;
  } catch {
    return {};
  }
}

function writeScanStarts(starts: ScanStarts): void {
  try {
    if (Object.keys(starts).length === 0) {
      window.sessionStorage.removeItem(SCAN_STARTS_KEY);
      return;
    }
    window.sessionStorage.setItem(SCAN_STARTS_KEY, JSON.stringify(starts));
  } catch {
    // Session storage can be unavailable in private or embedded contexts.
  }
}
