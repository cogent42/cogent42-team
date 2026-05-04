// Shared Postgres client — used by every service.
// Pool is process-wide; each service imports `pool` directly.

import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.PG_POOL_MAX || "10", 10),
  idleTimeoutMillis: 30_000,
});

pool.on("error", (err) => {
  // Don't crash the process on transient pool errors; log and continue.
  console.error("[db] pool error:", err.message);
});

/** Convenience: run a single query with positional params. */
export async function q(text, params) {
  const res = await pool.query(text, params);
  return res;
}

/** Run multiple statements in a single transaction. Caller writes the body. */
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Append a row to audit_log. Never throws — auditing must not block business logic. */
export async function audit({ actorUserId = null, actorRole, action, targetType = null, targetId = null, payload = null }) {
  try {
    await pool.query(
      `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [actorUserId, actorRole, action, targetType, targetId, payload]
    );
  } catch (err) {
    console.error("[audit] write failed:", err.message);
  }
}
