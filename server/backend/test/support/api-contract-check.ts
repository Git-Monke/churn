import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv, type ValidateFunction } from "ajv";

import { findRoute } from "../../src/api-contract.js";
import type { ServedResponse } from "../../src/server.js";

const openApiPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../openapi.json");

interface OpenApiDocument {
  components: { schemas: Record<string, unknown> };
}

let ajv: Ajv | null = null;
const validators = new Map<string, ValidateFunction>();

function validatorFor(typeName: string, array: boolean): ValidateFunction {
  const key = `${typeName}${array ? "[]" : ""}`;
  const existing = validators.get(key);
  if (existing) return existing;
  if (!ajv) {
    const document = JSON.parse(readFileSync(openApiPath, "utf8")) as OpenApiDocument;
    ajv = new Ajv({ allErrors: true, strict: false });
    ajv.addSchema({ $id: "openapi.json", components: document.components });
  }
  const ref = { $ref: `openapi.json#/components/schemas/${typeName}` };
  const validate = ajv.compile(array ? { type: "array", items: ref } : ref);
  validators.set(key, validate);
  return validate;
}

/**
 * Checks every JSON response a test server sends against the contract in
 * `openapi.json`: successful responses against their route's type, errors
 * against the error envelope. Call `assertClean()` after each test.
 */
export function createContractChecker() {
  const violations: string[] = [];
  let checked = 0;

  function check(response: ServedResponse): void {
    if (!response.contentType.includes("application/json") || typeof response.payload !== "string") return;
    if (!response.route?.startsWith("/api/")) return;
    let body: unknown;
    try {
      body = JSON.parse(response.payload);
    } catch {
      violations.push(`${response.method} ${response.route}: response is not JSON`);
      return;
    }
    let validate: ValidateFunction;
    if (response.statusCode >= 400) {
      validate = validatorFor("ErrorResponse", false);
    } else {
      const contract = findRoute(response.method, response.route);
      if (!contract || !("json" in contract.response)) return;
      validate = validatorFor(contract.response.json, contract.response.array ?? false);
    }
    checked += 1;
    if (!validate(body)) {
      const errors = (validate.errors ?? [])
        .map((error) => `${error.instancePath || "/"} ${error.message}${error.params ? ` ${JSON.stringify(error.params)}` : ""}`)
        .join("; ");
      violations.push(`${response.method} ${response.route} ${response.statusCode}: ${errors}`);
    }
  }

  return {
    check,
    /** How many JSON responses have been checked; for tests of the checker. */
    get checked(): number {
      return checked;
    },
    assertClean(): void {
      const found = violations.splice(0);
      if (found.length > 0) {
        throw new Error(`Responses that don't match the API contract:\n${found.join("\n")}`);
      }
    },
  };
}
