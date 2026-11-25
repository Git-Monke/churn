import type { FastifyInstance } from "fastify";

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self'",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export function registerSecurityHeaders(app: FastifyInstance) {
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("content-security-policy", CONTENT_SECURITY_POLICY);
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-frame-options", "DENY");
    reply.header("cross-origin-opener-policy", "same-origin");
    reply.header("cross-origin-resource-policy", "same-origin");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    if (request.protocol === "https") {
      reply.header("strict-transport-security", "max-age=31536000");
    }
    return payload;
  });
}