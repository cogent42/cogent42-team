// Bot instance lifecycle in Postgres — replaces ~/.cogent42/instances/*.json.

import { pool, audit } from "@cogent42-team/db";

export async function registerInstance({ userId, botName }) {
  await pool.query(
    `INSERT INTO instances (user_id, bot_name, started_at, last_seen_at)
     VALUES ($1, $2, now(), now())
     ON CONFLICT (user_id) DO UPDATE
       SET bot_name = EXCLUDED.bot_name,
           started_at = now(),
           last_seen_at = now()`,
    [userId, botName]
  );
  await audit({ actorUserId: userId, actorRole: "bot", action: "instance.start", targetType: "user", targetId: userId });
}

export async function heartbeat(userId) {
  await pool.query(`UPDATE instances SET last_seen_at = now() WHERE user_id = $1`, [userId]);
}
