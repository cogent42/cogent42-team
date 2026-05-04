import { pool, audit } from "@cogent42-team/db";
import { encryptString } from "@cogent42-team/shared/crypto";
import { provisionBot, teardownBot, botStatus, botLogs } from "../lib/docker.js";

function slugify(email) {
  const local = String(email).split("@")[0].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${local || "user"}-${suffix}`;
}

export async function usersRoutes(app) {
  // List all users
  app.get("/", async (_req, reply) => {
    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.name, u.slug, u.role, u.status,
              u.gmail_mode, u.share_to_team, u.created_at,
              i.last_seen_at, i.bot_name, i.container_id,
              (SELECT COUNT(*) FROM knowledge_entries WHERE owner_user_id = u.id AND deleted_at IS NULL) AS fact_count
         FROM users u
         LEFT JOIN instances i ON i.user_id = u.id
        ORDER BY u.created_at DESC`
    );
    reply.send({ users: rows });
  });

  // Create a new user (provisions bot container)
  app.post("/", async (req, reply) => {
    const { email, name, telegram_user_id, telegram_bot_token, bot_name, role = "member" } = req.body || {};
    if (!email || !name || !telegram_user_id || !telegram_bot_token || !bot_name) {
      return reply.code(400).send({ error: "email, name, telegram_user_id, telegram_bot_token, bot_name are required" });
    }

    const slug = slugify(email);

    // Insert user + secrets atomically
    const userId = await pool.query(
      `INSERT INTO users (email, name, slug, telegram_user_id, telegram_bot_name, role, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'provisioning')
       RETURNING id`,
      [email, name, slug, telegram_user_id, bot_name, role]
    ).then(r => r.rows[0].id);

    await pool.query(
      `INSERT INTO user_secrets (user_id, telegram_token_enc) VALUES ($1, $2)`,
      [userId, encryptString(telegram_bot_token)]
    );

    // Provision container
    let containerInfo;
    try {
      containerInfo = await provisionBot({
        user: { id: userId, slug },
        env: {
          OWNER_USER_ID:             userId,
          OWNER_EMAIL:               email,
          BOT_NAME:                  bot_name,
          TELEGRAM_USER_ID:          String(telegram_user_id),
          TELEGRAM_BOT_TOKEN:        telegram_bot_token,
          DATABASE_URL:              process.env.DATABASE_URL,
          MASTER_KEY:                process.env.MASTER_KEY,
          OPENAI_API_KEY:            process.env.OPENAI_API_KEY,
          // Forwarded so the bot can mint Gmail consent URLs in /gmail without
          // needing admin-token access to the control-plane. Client *secret* is
          // intentionally NOT forwarded — token exchange happens on the callback.
          GOOGLE_CLIENT_ID:          process.env.GOOGLE_CLIENT_ID || "",
          GOOGLE_OAUTH_REDIRECT_URI: process.env.GOOGLE_OAUTH_REDIRECT_URI || "",
        },
      });
    } catch (err) {
      app.log.error({ err }, "provisionBot failed");
      await pool.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [userId]);
      return reply.code(500).send({ error: "provisioning failed", details: err.message });
    }

    await pool.query(
      `INSERT INTO instances (user_id, container_id, container_name, bot_name, started_at, last_seen_at)
       VALUES ($1, $2, $3, $4, now(), now())
       ON CONFLICT (user_id) DO UPDATE
         SET container_id = EXCLUDED.container_id,
             container_name = EXCLUDED.container_name,
             bot_name = EXCLUDED.bot_name,
             started_at = now(),
             last_seen_at = now()`,
      [userId, containerInfo.id, containerInfo.name, bot_name]
    );

    await pool.query(`UPDATE users SET status = 'active' WHERE id = $1`, [userId]);
    await audit({ actorRole: "admin", action: "provision", targetType: "user", targetId: userId, payload: { slug } });

    reply.send({ id: userId, slug, container: containerInfo });
  });

  // Get a single user with full detail
  app.get("/:id", async (req, reply) => {
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT u.*, i.bot_name, i.container_id, i.container_name, i.last_seen_at AS instance_last_seen
         FROM users u LEFT JOIN instances i ON i.user_id = u.id
        WHERE u.id = $1`,
      [id]
    );
    if (rows.length === 0) return reply.code(404).send({ error: "not_found" });
    const user = rows[0];
    user.docker = await botStatus(user.slug);
    reply.send({ user });
  });

  // Update gmail_mode / share_to_team / role / status
  app.patch("/:id", async (req, reply) => {
    const { id } = req.params;
    const { gmail_mode, share_to_team, role, status } = req.body || {};
    const sets = [];
    const vals = [];
    let i = 1;
    if (gmail_mode    !== undefined) { sets.push(`gmail_mode = $${i++}`);    vals.push(gmail_mode); }
    if (share_to_team !== undefined) { sets.push(`share_to_team = $${i++}`); vals.push(share_to_team); }
    if (role          !== undefined) { sets.push(`role = $${i++}`);          vals.push(role); }
    if (status        !== undefined) { sets.push(`status = $${i++}`);        vals.push(status); }
    if (sets.length === 0) return reply.send({ updated: false });
    sets.push(`updated_at = now()`);
    vals.push(id);
    await pool.query(`UPDATE users SET ${sets.join(", ")} WHERE id = $${i}`, vals);
    await audit({ actorRole: "admin", action: "user.update", targetType: "user", targetId: id, payload: req.body });
    reply.send({ updated: true });
  });

  // Restart bot container
  app.post("/:id/restart", async (req, reply) => {
    const { id } = req.params;
    const { rows } = await pool.query(`SELECT * FROM users WHERE id = $1`, [id]);
    if (rows.length === 0) return reply.code(404).send({ error: "not_found" });
    const user = rows[0];

    // Re-fetch token (encrypted) and re-provision
    const sec = await pool.query(`SELECT * FROM user_secrets WHERE user_id = $1`, [id]).then(r => r.rows[0]);
    if (!sec) return reply.code(400).send({ error: "no secrets stored" });

    const { decryptString } = await import("@cogent42-team/shared/crypto");
    const telegram_bot_token = decryptString(sec.telegram_token_enc);

    await teardownBot(user.slug);
    const containerInfo = await provisionBot({
      user: { id: user.id, slug: user.slug },
      env: {
        OWNER_USER_ID:      user.id,
        OWNER_EMAIL:        user.email,
        BOT_NAME:           user.telegram_bot_name,
        TELEGRAM_USER_ID:   String(user.telegram_user_id),
        TELEGRAM_BOT_TOKEN:        telegram_bot_token,
        DATABASE_URL:              process.env.DATABASE_URL,
        MASTER_KEY:                process.env.MASTER_KEY,
        OPENAI_API_KEY:            process.env.OPENAI_API_KEY,
        GOOGLE_CLIENT_ID:          process.env.GOOGLE_CLIENT_ID || "",
        GOOGLE_OAUTH_REDIRECT_URI: process.env.GOOGLE_OAUTH_REDIRECT_URI || "",
      },
    });

    // UPSERT — earlier provisioning may have failed before any instances row was written.
    await pool.query(
      `INSERT INTO instances (user_id, container_id, container_name, bot_name, started_at, last_seen_at)
       VALUES ($1, $2, $3, $4, now(), now())
       ON CONFLICT (user_id) DO UPDATE
         SET container_id   = EXCLUDED.container_id,
             container_name = EXCLUDED.container_name,
             started_at     = now(),
             last_seen_at   = now()`,
      [id, containerInfo.id, containerInfo.name, user.telegram_bot_name]
    );
    await audit({ actorRole: "admin", action: "restart", targetType: "user", targetId: id });
    reply.send({ container: containerInfo });
  });

  // Bot logs (last N lines)
  app.get("/:id/logs", async (req, reply) => {
    const { id } = req.params;
    const tail = parseInt(req.query.tail || "200", 10);
    const { rows } = await pool.query(`SELECT slug FROM users WHERE id = $1`, [id]);
    if (rows.length === 0) return reply.code(404).send({ error: "not_found" });
    try {
      const logs = await botLogs(rows[0].slug, { tail });
      reply.type("text/plain").send(logs);
    } catch (err) {
      reply.code(500).send({ error: err.message });
    }
  });

  // Disable + tear down
  app.delete("/:id", async (req, reply) => {
    const { id } = req.params;
    const purge = req.query.purge === "true";
    const { rows } = await pool.query(`SELECT slug FROM users WHERE id = $1`, [id]);
    if (rows.length === 0) return reply.code(404).send({ error: "not_found" });

    await teardownBot(rows[0].slug);
    await pool.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [id]);

    if (purge) {
      await pool.query(`DELETE FROM knowledge_entries WHERE owner_user_id = $1`, [id]);
      await pool.query(`DELETE FROM extraction_jobs   WHERE user_id      = $1`, [id]);
      await pool.query(`DELETE FROM chat_sessions     WHERE user_id      = $1`, [id]);
      await audit({ actorRole: "admin", action: "purge", targetType: "user", targetId: id });
    } else {
      await audit({ actorRole: "admin", action: "disable", targetType: "user", targetId: id });
    }
    reply.send({ disabled: true, purged: purge });
  });
}
