// Working memory for the active Telegram conversation.
// On idle (≥60s) or /done, the session is flushed to extraction_jobs.

import { pool } from "@cogent42-team/db";

const IDLE_FLUSH_MS = 60_000;
const MAX_MESSAGES_PER_SESSION = 100;

/** Append to the user's most recent open session, or create one. */
export async function appendChatMessage(userId, role, content) {
  const { rows } = await pool.query(
    `SELECT id, messages FROM chat_sessions
      WHERE user_id = $1 AND flushed_at IS NULL
      ORDER BY last_msg_at DESC LIMIT 1`,
    [userId]
  );

  const msg = { role, content, at: new Date().toISOString() };

  if (rows.length === 0 || (rows[0].messages?.length || 0) >= MAX_MESSAGES_PER_SESSION) {
    await pool.query(
      `INSERT INTO chat_sessions (user_id, messages, last_msg_at)
       VALUES ($1, $2::jsonb, now())`,
      [userId, JSON.stringify([msg])]
    );
    return;
  }

  await pool.query(
    `UPDATE chat_sessions
        SET messages = messages || $2::jsonb,
            last_msg_at = now()
      WHERE id = $1`,
    [rows[0].id, JSON.stringify([msg])]
  );
}

/** Mark a user's open session as flushed and enqueue an extraction job. */
export async function flushSession(userId, { reason = "idle" } = {}) {
  const { rows } = await pool.query(
    `SELECT id, messages FROM chat_sessions
      WHERE user_id = $1 AND flushed_at IS NULL
      ORDER BY last_msg_at DESC LIMIT 1`,
    [userId]
  );
  if (rows.length === 0) return false;
  const session = rows[0];

  // Trivial sessions (≤2 messages) aren't worth extracting.
  if ((session.messages?.length || 0) < 3) {
    await pool.query(`UPDATE chat_sessions SET flushed_at = now() WHERE id = $1`, [session.id]);
    return false;
  }

  await pool.query(
    `INSERT INTO extraction_jobs (user_id, source, source_ref, payload)
     VALUES ($1, 'chat', $2, $3::jsonb)`,
    [userId, session.id, JSON.stringify({ messages: session.messages, reason })]
  );
  await pool.query(`UPDATE chat_sessions SET flushed_at = now() WHERE id = $1`, [session.id]);
  return true;
}

/** Periodic sweep — flushes sessions idle for IDLE_FLUSH_MS across all users this bot owns. */
export async function flushIdleSessions() {
  const { rows } = await pool.query(
    `SELECT id, user_id FROM chat_sessions
      WHERE flushed_at IS NULL
        AND last_msg_at < now() - ($1::int || ' milliseconds')::interval`,
    [IDLE_FLUSH_MS]
  );
  for (const r of rows) {
    await flushSession(r.user_id, { reason: "idle" }).catch((e) =>
      console.error("flushSession failed:", e.message)
    );
  }
}
