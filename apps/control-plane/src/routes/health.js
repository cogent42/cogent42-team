import { pool } from "@cogent42-team/db";

export async function healthRoutes(app) {
  app.get("/health", async (_req, reply) => {
    try {
      await pool.query("SELECT 1");
      reply.send({ ok: true });
    } catch (err) {
      reply.code(503).send({ ok: false, error: err.message });
    }
  });
}
