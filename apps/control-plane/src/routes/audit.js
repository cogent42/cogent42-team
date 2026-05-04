import { pool } from "@cogent42-team/db";

export async function auditRoutes(app) {
  app.get("/", async (req, reply) => {
    const limit  = Math.min(parseInt(req.query.limit  || "100", 10), 1000);
    const offset = parseInt(req.query.offset || "0", 10);
    const target = req.query.target_id || null;

    const conds = [];
    const vals  = [];
    let i = 1;
    if (target) { conds.push(`target_id = $${i++}`); vals.push(target); }
    vals.push(limit, offset);

    const sql = `
      SELECT a.*, u.email AS actor_email
        FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
       ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""}
       ORDER BY a.at DESC
       LIMIT $${i++} OFFSET $${i++}`;
    const { rows } = await pool.query(sql, vals);
    reply.send({ events: rows });
  });
}
