import path from "node:path";
import { fileURLToPath } from "node:url";

import { createGenerator, type Schema } from "ts-json-schema-generator";

import { API_ROUTES, type ParameterContract, type RouteContract } from "../src/api-contract.js";
import { CURRENT_API_VERSION } from "../src/api-version.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(here, "..");
export const OPENAPI_PATH = path.resolve(backendDir, "..", "openapi.json");

/** Files whose exported types make up the API's response shapes. */
const TYPE_FILES = ["src/types.ts", "src/playback.ts"];

type JsonObject = Record<string, unknown>;

/**
 * Build the OpenAPI 3.1 document from the route table and the TypeScript
 * types it names. Deterministic: the same sources always give the same JSON.
 */
export function buildOpenApi(): JsonObject {
  const typeNames = new Set<string>(["ErrorResponse"]);
  for (const route of API_ROUTES) {
    if ("json" in route.response) typeNames.add(route.response.json);
  }

  const schemas: Record<string, Schema> = {};
  for (const file of TYPE_FILES) {
    const generator = createGenerator({
      path: path.join(backendDir, file),
      tsconfig: path.join(backendDir, "tsconfig.json"),
      skipTypeCheck: true,
      expose: "export",
      topRef: false,
      jsDoc: "basic",
      additionalProperties: false,
    });
    for (const name of typeNames) {
      let schema: Schema;
      try {
        schema = generator.createSchema(name);
      } catch {
        continue; // Defined in the other file.
      }
      const { definitions, $schema: _ignored, ...root } = schema as Schema & { definitions?: Record<string, Schema> };
      schemas[name] = root;
      for (const [key, value] of Object.entries(definitions ?? {})) {
        schemas[key] = value;
      }
    }
  }
  for (const name of typeNames) {
    if (!schemas[name]) throw new Error(`No exported type named ${name} in ${TYPE_FILES.join(" or ")}`);
  }

  const paths: Record<string, JsonObject> = {};
  for (const route of API_ROUTES) {
    // Documented under the current version: clients that ship separately call /api/v{n}.
    // Fastify's trailing wildcard becomes a named `{path}` parameter.
    const openApiPath = route.path
      .replace(/^\/api\//, `/api/v${CURRENT_API_VERSION}/`)
      .replace(/:([A-Za-z]+)/g, "{$1}")
      .replace(/\/\*$/, "/{path}");
    paths[openApiPath] ??= {};
    paths[openApiPath][route.method.toLowerCase()] = operation(route);
  }

  return rewriteRefs(
    sortKeys({
      openapi: "3.1.0",
      info: {
        title: "churn",
        // The API version, not the server's release.
        version: String(CURRENT_API_VERSION),
        description:
          "The API behind churn's dashboard. Generated from server/backend/src/api-contract.ts and the types it names; do not edit by hand. Run `npm run api:generate` in server/.",
      },
      paths,
      components: {
        schemas,
        securitySchemes: {
          session: { type: "apiKey", in: "cookie", name: "churn_session" },
        },
      },
    }),
  ) as JsonObject;
}

function operation(route: RouteContract): JsonObject {
  const parameters = [
    ...[...route.path.matchAll(/:([A-Za-z]+)/g)].map((match) => {
      const name = match[1]!;
      const described = route.params?.[name];
      return parameter("path", { name, required: true, description: described?.description ?? "", schema: described?.schema ?? { type: "string" } });
    }),
    ...(route.path.endsWith("/*")
      ? [
          parameter("path", {
            name: "path",
            required: true,
            description: route.params?.["*"]?.description ?? "",
            schema: { type: "string" },
          }),
        ]
      : []),
    ...(route.query ?? []).map((query) => parameter("query", query)),
  ];
  return {
    operationId: operationId(route),
    summary: route.summary,
    ...(route.auth === "none" ? { security: [] } : { security: [{ session: [] }] }),
    ...(route.auth === "admin" ? { description: "Administrators only." } : {}),
    ...(parameters.length > 0 ? { parameters } : {}),
    responses: {
      [String(("status" in route.response && route.response.status) || successStatus(route))]: success(route),
      default: {
        description: "An error, as `{ error: { code, message } }`.",
        content: { "application/json": { schema: { $ref: "#/definitions/ErrorResponse" } } },
      },
    },
  };
}

function successStatus(route: RouteContract): number {
  return "redirect" in route.response ? 302 : 200;
}

function success(route: RouteContract): JsonObject {
  const response = route.response;
  if ("json" in response) {
    const ref = { $ref: `#/definitions/${response.json}` };
    return {
      description: "OK",
      content: { "application/json": { schema: response.array ? { type: "array", items: ref } : ref } },
    };
  }
  if ("contentType" in response) {
    return { description: "OK", content: { [response.contentType]: {} } };
  }
  if ("redirect" in response) {
    return { description: "Redirect", headers: { location: { schema: { type: "string" } } } };
  }
  return { description: "No content" };
}

function parameter(where: "path" | "query", contract: ParameterContract): JsonObject {
  return {
    name: contract.name,
    in: where,
    required: where === "path" ? true : Boolean(contract.required),
    ...(contract.description ? { description: contract.description } : {}),
    schema: contract.schema,
  };
}

function operationId(route: RouteContract): string {
  const words = route.path
    .replace(/^\/api\//, "")
    .split(/[/.-]/)
    .filter(Boolean)
    .map((part) => (part.startsWith(":") ? `by ${part.slice(1)}` : part))
    .join(" ")
    .split(" ");
  return [route.method.toLowerCase(), ...words]
    .map((word, index) => (index === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join("");
}

/** ts-json-schema-generator writes `#/definitions/X`; OpenAPI wants `#/components/schemas/X`. */
function rewriteRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteRefs);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        key === "$ref" && typeof entry === "string"
          ? entry.replace("#/definitions/", "#/components/schemas/")
          : rewriteRefs(entry),
      ]),
    );
  }
  return value;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as JsonObject)[key])]),
    );
  }
  return value;
}

export function serialize(document: JsonObject): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
