import type { FastifyInstance } from "fastify";

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get("/api/health", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return { status: "ok" };
  });
}
