import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import openapiTS, { astToString } from "openapi-typescript";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("generated API types", () => {
  it("match server/openapi.json", async () => {
    const source = new URL(`file://${path.resolve(here, "../../../openapi.json")}`);
    const expected = astToString(await openapiTS(source));
    const committed = readFileSync(path.join(here, "generated/openapi.ts"), "utf8");
    // The CLI adds a banner; compare the generated declarations only.
    expect(
      committed.endsWith(expected),
      "src/api/generated/openapi.ts is stale. Run `npm run api:generate` in server/ and commit the result.",
    ).toBe(true);
  }, 30_000);
});
