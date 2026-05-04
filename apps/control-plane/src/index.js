// cogent42-team control plane.
// Responsibilities:
//   - Admin REST API (users, knowledge browser, gmail OAuth, audit)
//   - Provision/teardown of per-user bot containers via Docker socket
//   - Static admin UI (single-page, served from public/)

import Fastify from "fastify";
import formBody from "@fastify/formbody";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { healthRoutes } from "./routes/health.js";
import { infoRoutes } from "./routes/info.js";
import { usersRoutes } from "./routes/users.js";
import { knowledgeRoutes } from "./routes/knowledge.js";
import { gmailRoutes } from "./routes/gmail.js";
import { auditRoutes } from "./routes/audit.js";
import { requireAdmin } from "./lib/auth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.CONTROL_PLANE_PORT || "8080", 10);
const HOST = "0.0.0.0";

if (!process.env.ADMIN_TOKEN) {
  console.error("FATAL: ADMIN_TOKEN env var not set");
  process.exit(1);
}
if (!process.env.MASTER_KEY) {
  console.error("FATAL: MASTER_KEY env var not set");
  process.exit(1);
}

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || "info" },
  trustProxy: true,
});

await app.register(formBody);
await app.register(fastifyStatic, {
  root: join(__dirname, "..", "public"),
  prefix: "/",
  decorateReply: false,
});

// Public — health + landing-page info
await app.register(healthRoutes);
await app.register(infoRoutes, { prefix: "/api/info" });

// Gmail OAuth callback is public (Google redirects user-agent here)
await app.register(gmailRoutes, { prefix: "/api/gmail" });

// Everything else is admin-only
app.register(async (admin) => {
  admin.addHook("onRequest", requireAdmin);
  await admin.register(usersRoutes,     { prefix: "/api/users" });
  await admin.register(knowledgeRoutes, { prefix: "/api/knowledge" });
  await admin.register(auditRoutes,     { prefix: "/api/audit" });
});

try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`cogent42-team control-plane listening on :${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
