// Gmail-worker — single shared worker for all users.
// Responsibilities:
//   - For each user with a connected Gmail account, poll for new SENT messages
//   - Optionally expand to threads the user replied in
//   - Enqueue extraction_jobs (source='gmail') for the extractor-worker to process
// Strict default: SENT-only. Inbox is never scanned unless user explicitly opts into 'full_inbox'.

import { pool, audit } from "@cogent42-team/db";
import { fetchSentMessages } from "./gmail.js";

const POLL_SEC = parseInt(process.env.GMAIL_POLL_INTERVAL_SEC || "60", 10);
const MAX_PER_USER_PER_TICK = 25;

async function listConnectedUsers() {
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.gmail_mode, u.gmail_label_id, u.gmail_history_id
       FROM users u JOIN user_secrets s ON s.user_id = u.id
      WHERE u.status = 'active'
        AND u.gmail_mode <> 'disabled'
        AND s.gmail_refresh_token_enc IS NOT NULL`
  );
  return rows;
}

async function processUser(user) {
  let messages;
  try {
    messages = await fetchSentMessages({
      userId: user.id,
      mode: user.gmail_mode,
      labelId: user.gmail_label_id,
      max: MAX_PER_USER_PER_TICK,
    });
  } catch (err) {
    console.error(`[gmail] ${user.email} fetch failed:`, err.message);
    return 0;
  }

  let enqueued = 0;
  for (const m of messages) {
    // Idempotency: skip if we've already extracted this gmail message_id for this user.
    const existing = await pool.query(
      `SELECT 1 FROM knowledge_entries
        WHERE owner_user_id = $1 AND source = 'gmail' AND source_ref = $2
        LIMIT 1`,
      [user.id, m.id]
    );
    if (existing.rows.length > 0) continue;

    // Or skip if a job for this message is already pending/processing.
    const pending = await pool.query(
      `SELECT 1 FROM extraction_jobs
        WHERE user_id = $1 AND source = 'gmail' AND source_ref = $2
          AND status IN ('pending','processing')
        LIMIT 1`,
      [user.id, m.id]
    );
    if (pending.rows.length > 0) continue;

    await pool.query(
      `INSERT INTO extraction_jobs (user_id, source, source_ref, payload)
       VALUES ($1, 'gmail', $2, $3::jsonb)`,
      [user.id, m.id, JSON.stringify(m)]
    );
    enqueued++;
  }

  if (enqueued > 0) {
    await audit({
      actorUserId: user.id, actorRole: "gmail-worker", action: "gmail.enqueue",
      targetType: "user", targetId: user.id, payload: { count: enqueued },
    });
    console.log(`[gmail] ${user.email}: enqueued ${enqueued} message(s)`);
  }
  return enqueued;
}

async function tick() {
  const users = await listConnectedUsers();
  for (const u of users) {
    await processUser(u).catch((e) => console.error(`[gmail] ${u.email}:`, e.message));
  }
}

async function loop() {
  while (true) {
    await tick().catch((e) => console.error("[gmail] tick failed:", e.message));
    await new Promise((r) => setTimeout(r, POLL_SEC * 1000));
  }
}

console.log(`[gmail] starting; poll every ${POLL_SEC}s, SENT-only default`);
loop();
