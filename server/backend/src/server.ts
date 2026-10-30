import { existsSync } from "node:fs";
import path from "node:path";

import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";

import type { AppConfig } from "./config.js";
import { ApiError, UpstreamError } from "./errors.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerLibraryRoutes } from "./routes/library.js";
import { registerServiceRoutes } from "./routes/services.js";
import { registerStatusRoutes } from "./routes/status.js";

interface BuildServerOptions {
  logger?: boolean;
}

export async function buildServer(
  config: AppConfig,
  options: BuildServerOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message } });
    }
    if (error instanceof UpstreamError) {
      return reply
        .code(502)
        .send({ error: { code: "upstream_error", message: error.message } });
    }
    request.log.error({ err: error }, "request failed");
    return reply
      .code(500)
      .send({ error: { code: "internal_error", message: "Internal server error" } });
  });

  registerHealthRoutes(app);
  registerStatusRoutes(app, config);
  registerLibraryRoutes(app, config);
  registerServiceRoutes(app, config);

  const hasFrontend = existsSync(path.join(config.frontendDist, "index.html"));
  if (hasFrontend) {
    await app.register(fastifyStatic, {
      root: config.frontendDist,
      wildcard: false,
    });
  } else {
    app.log.warn(`frontend build not found at ${config.frontendDist}; run npm run build`);
  }

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply
        .code(404)
        .send({ error: { code: "not_found", message: "API route not found" } });
    }
    if (!hasFrontend) {
      return reply.code(503).send({
        error: {
          code: "frontend_not_built",
          message: "Frontend not built. Run npm run build in server/.",
        },
      });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return reply
        .code(404)
        .send({ error: { code: "not_found", message: "Not found" } });
    }
    return reply.sendFile("index.html");
  });

  return app;
}
