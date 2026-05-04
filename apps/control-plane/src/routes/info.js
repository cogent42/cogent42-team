// Public info endpoint — no admin token required.
// Exposes only the few values the public landing page needs (admin contact email).
// Keep this small; nothing user-or-fact-specific belongs here.

export async function infoRoutes(app) {
  app.get("/", async (_req, reply) => {
    reply.send({
      adminEmail: process.env.ADMIN_CONTACT_EMAIL || null,
    });
  });
}
