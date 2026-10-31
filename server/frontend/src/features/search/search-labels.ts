import type { RequestMonitor } from "@/api/types";

export const MONITOR_LABELS: Record<RequestMonitor, string> = {
  all: "All seasons",
  firstSeason: "First season",
  future: "Future episodes",
  none: "None",
};

export function seasonMonitorLabel(monitor: RequestMonitor | undefined): string {
  return MONITOR_LABELS[monitor ?? "all"];
}
