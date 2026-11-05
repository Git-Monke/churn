import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createMediaAttributionStore,
  mediaAttributionKey,
  MEDIA_ATTRIBUTION_FILENAME,
} from "../src/media-attribution.js";

const dirs: string[] = [];

function makeStateDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "churn-attribution-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const movie = { kind: "movie" as const, tmdbId: 438631 };
const series = { kind: "series" as const, tvdbId: 371980 };

describe("media attribution", () => {
  it("uses provider identity and ignores titles without one", () => {
    expect(mediaAttributionKey({ kind: "movie", tmdbId: 438631 })).toBe(
      "movie:tmdb:438631",
    );
    expect(mediaAttributionKey({ kind: "series", tvdbId: 371980 })).toBe(
      "series:tvdb:371980",
    );
    expect(mediaAttributionKey({ kind: "series", tmdbId: 1399 })).toBe(
      "series:tmdb:1399",
    );
    expect(mediaAttributionKey({ kind: "movie" })).toBeUndefined();
  });

  it("records an added-by tag and reloads it from the state file", async () => {
    const stateDir = makeStateDir();
    const store = createMediaAttributionStore({
      stateDir,
      now: () => new Date("2026-04-01T12:00:00.000Z"),
    });

    await store.record(movie, { id: "user-1", name: "Ada" });

    expect(store.get(movie)).toEqual({ id: "user-1", name: "Ada" });
    expect(store.get(series)).toBeUndefined();

    const reloaded = createMediaAttributionStore({ stateDir });
    expect(reloaded.get(movie)).toEqual({ id: "user-1", name: "Ada" });

    const persisted = JSON.parse(
      readFileSync(path.join(stateDir, MEDIA_ATTRIBUTION_FILENAME), "utf8"),
    ) as { version: number; entries: Array<{ key: string; addedAt: string }> };
    expect(persisted.version).toBe(1);
    expect(persisted.entries).toEqual([
      {
        key: "movie:tmdb:438631",
        addedBy: { id: "user-1", name: "Ada" },
        addedAt: "2026-04-01T12:00:00.000Z",
      },
    ]);
  });

  it("serializes concurrent records without dropping either title", async () => {
    const stateDir = makeStateDir();
    const store = createMediaAttributionStore({ stateDir });

    await Promise.all([
      store.record(movie, { id: "user-1", name: "Ada" }),
      store.record(series, { id: "user-2", name: "Grace" }),
    ]);

    const reloaded = createMediaAttributionStore({ stateDir });
    expect(reloaded.get(movie)).toEqual({ id: "user-1", name: "Ada" });
    expect(reloaded.get(series)).toEqual({ id: "user-2", name: "Grace" });
  });

  it("removes a tag and persists the removal", async () => {
    const stateDir = makeStateDir();
    const store = createMediaAttributionStore({ stateDir });
    await store.record(movie, { id: "user-1", name: "Ada" });

    await store.remove(movie);

    expect(store.get(movie)).toBeUndefined();
    const reloaded = createMediaAttributionStore({ stateDir });
    expect(reloaded.get(movie)).toBeUndefined();
  });

  it("starts empty and warns when the state file is corrupt", () => {
    const stateDir = makeStateDir();
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, MEDIA_ATTRIBUTION_FILENAME), "{not json", "utf8");
    const warnings: string[] = [];

    const store = createMediaAttributionStore({
      stateDir,
      onWarning: (message) => warnings.push(message),
    });

    expect(store.get(movie)).toBeUndefined();
    expect(warnings.some((message) => message.includes("corrupt"))).toBe(true);
  });
});
