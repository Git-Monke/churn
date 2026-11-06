import { describe, expect, it } from "vitest";

import {
  AVAILABILITY_EXCELLENT_SEEDERS,
  AVAILABILITY_GOOD_SEEDERS,
  releaseAvailability,
} from "./availability";

describe("release availability", () => {
  it("calls 200 or more seeders excellent", () => {
    expect(releaseAvailability(AVAILABILITY_EXCELLENT_SEEDERS).level).toBe("excellent");
    expect(releaseAvailability(412)).toEqual({
      level: "excellent",
      label: "Excellent · 412 seeders",
      dotClassName: "bg-emerald-300",
      textClassName: "text-foreground",
    });
  });

  it("calls 50–199 seeders good", () => {
    expect(releaseAvailability(AVAILABILITY_GOOD_SEEDERS).level).toBe("good");
    expect(releaseAvailability(49).level).toBe("low");
    expect(releaseAvailability(199).level).toBe("good");
    expect(releaseAvailability(199).label).toBe("Good · 199 seeders");
    expect(releaseAvailability(50).label).toBe("Good · 50 seeders");
    expect(releaseAvailability(1).label).toBe("Low · 1 seeder · may stall");
  });

  it("warns below 50 seeders", () => {
    const low = releaseAvailability(12);
    expect(low).toEqual({
      level: "low",
      label: "Low · 12 seeders · may stall",
      dotClassName: "bg-destructive",
      textClassName: "text-destructive",
    });
    expect(releaseAvailability(0).level).toBe("low");
  });

  it("degrades gracefully when seeders are unknown", () => {
    const unknown = releaseAvailability(undefined);
    expect(unknown.level).toBe("unknown");
    expect(unknown.label).toBe("Seeders unknown");
    expect(unknown.textClassName).toBe("text-muted-foreground");
  });
});
