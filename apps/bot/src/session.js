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

/**
 * Flush a session and enqueue an extraction job atomically.
 *
 * Single CTE so concurrent callers (the /done command + the idle sweep, or two
 * sweeps overlapping) can't double-enqueue: only one UPDATE wins; the loser sees
 * 0 rows from `claimed` and skips the INSERT. Trivial sessions (<3 messages) are
 * still claimed but not enqueued.
 *
 * If `sessionId` is omitted, falls back to "the user's most recent open session"
 * — that path is only safe to use from /done, which always means the active session.
 */
export async function flushSession(userId, { sessionId = null, reason = "idle" } = {}) {
  if (!sessionId) {
    const { rows } = await pool.query(
      `SELECT id FROM chat_sessions
        WHERE user_id = $1 AND flushed_at IS NULL
        ORDER BY last_msg_at DESC
        LIMIT 1`,
      [userId]
    );
    if (rows.length === 0) return false;
    sessionId = rows[0].id;
  }

  const { rows } = await pool.query(
    `WITH claimed AS (
       UPDATE chat_sessions
          SET flushed_at = now()
        WHERE id = $1 AND user_id = $2 AND flushed_at IS NULL
        RETURNING id, messages, jsonb_array_length(messages) AS n
     ),
     enq AS (
       INSERT INTO extraction_jobs (user_id, source, source_ref, payload)
       SELECT $2::uuid, 'chat', id::text, jsonb_build_object('messages', messages, 'reason', $3::text)
         FROM claimed
        WHERE n >= 3
       RETURNING id
     )
     SELECT (SELECT count(*)::int FROM enq) AS enqueued`,
    [sessionId, userId, reason]
  );
  return (rows[0]?.enqueued || 0) > 0;
}

/**
 * Periodic sweep — flushes sessions idle for IDLE_FLUSH_MS for THIS bot's owner only.
 * Multi-tenancy: every bot container runs its own sweep against its own user_id, so
 * Bot-A never touches Bot-B's sessions. We also pass each session's id explicitly
 * so flushSession claims that exact row, never "the latest open one for the user"
 * (which would be wrong if a 100-message rollover created a fresh session).
 */
export async function flushIdleSessions(userId) {
  if (!userId) throw new Error("flushIdleSessions: userId required");
  const { rows } = await pool.query(
    `SELECT id FROM chat_sessions
      WHERE user_id = $1
        AND flushed_at IS NULL
        AND last_msg_at < now() - ($2::int || ' milliseconds')::interval`,
    [userId, IDLE_FLUSH_MS]
  );
  for (const r of rows) {
    await flushSession(userId, { sessionId: r.id, reason: "idle" }).catch((e) =>
      console.error("flushSession failed:", e.message)
    );
  }
}
