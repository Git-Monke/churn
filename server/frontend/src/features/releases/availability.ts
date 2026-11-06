/**
 * Seeder thresholds for the release availability readout. The number of seeds
 * a swarm reports is the best available proxy for "will this actually
 * download", so both bands live here as named constants.
 */
export const AVAILABILITY_EXCELLENT_SEEDERS = 200;
export const AVAILABILITY_GOOD_SEEDERS = 50;

export type AvailabilityLevel = "excellent" | "good" | "low" | "unknown";

export interface ReleaseAvailability {
  level: AvailabilityLevel;
  /** `Excellent · 412 seeders`, `Low · 12 seeders · may stall`, … */
  label: string;
  /** Theme utility for the dot. */
  dotClassName: string;
  /** Theme utility for the label text. */
  textClassName: string;
}

function seedersLabel(count: number): string {
  return `${count} ${count === 1 ? "seeder" : "seeders"}`;
}

export function releaseAvailability(seeders: number | undefined): ReleaseAvailability {
  if (seeders === undefined || !Number.isFinite(seeders)) {
    return {
      level: "unknown",
      label: "Seeders unknown",
      dotClassName: "bg-muted-foreground/60",
      textClassName: "text-muted-foreground",
    };
  }
  if (seeders >= AVAILABILITY_EXCELLENT_SEEDERS) {
    return {
      level: "excellent",
      label: `Excellent · ${seedersLabel(seeders)}`,
      dotClassName: "bg-emerald-300",
      textClassName: "text-foreground",
    };
  }
  if (seeders >= AVAILABILITY_GOOD_SEEDERS) {
    return {
      level: "good",
      label: `Good · ${seedersLabel(seeders)}`,
      dotClassName: "bg-muted-foreground",
      textClassName: "text-foreground",
    };
  }
  return {
    level: "low",
    label: `Low · ${seedersLabel(seeders)} · may stall`,
    dotClassName: "bg-destructive",
    textClassName: "text-destructive",
  };
}
