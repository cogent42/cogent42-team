import { pool, audit } from "@cogent42-team/db";

export async function knowledgeRoutes(app) {
  // List facts (filterable). Admin sees everything across all users.
  app.get("/", async (req, reply) => {
    const userId   = req.query.user_id || null;
    const category = req.query.category || null;
    const source   = req.query.source || null;
    const acl      = req.query.acl || null;
    const q        = req.query.q || null;
    const limit    = Math.min(parseInt(req.query.limit  || "50", 10), 500);
    const offset   = parseInt(req.query.offset || "0", 10);

    const conds = ["ke.deleted_at IS NULL"];
    const vals  = [];
    let i = 1;
    if (userId)   { conds.push(`ke.owner_user_id = $${i++}`); vals.push(userId); }
    if (category) { conds.push(`ke.category = $${i++}`);      vals.push(category); }
    if (source)   { conds.push(`ke.source = $${i++}`);        vals.push(source); }
    if (acl)      { conds.push(`ke.acl = $${i++}`);           vals.push(acl); }
    if (q)        { conds.push(`ke.fact_tsv @@ plainto_tsquery('simple', $${i++})`); vals.push(q); }

    vals.push(limit, offset);
    const sql = `
      SELECT ke.id, ke.fact, ke.category, ke.importance, ke.acl, ke.source, ke.source_ref,
             ke.created_at, ke.last_seen_at,
             u.email AS owner_email, u.name AS owner_name
        FROM knowledge_entries ke
        JOIN users u ON u.id = ke.owner_user_id
       WHERE ${conds.join(" AND ")}
       ORDER BY ke.last_seen_at DESC
       LIMIT $${i++} OFFSET $${i++}`;

    const { rows } = await pool.query(sql, vals);
    reply.send({ entries: rows });
  });

  // Single entry (full row including supersede chain)
  app.get("/:id", async (req, reply) => {
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT * FROM knowledge_entries WHERE id = $1`,
      [id]
    );
    if (rows.length === 0) return reply.code(404).send({ error: "not_found" });
    await audit({ actorRole: "admin", action: "knowledge.read", targetType: "knowledge_entry", targetId: id });
    reply.send({ entry: rows[0] });
  });

  // Patch ACL / category / importance
  app.patch("/:id", async (req, reply) => {
    const { id } = req.params;
    const { acl, category, importance } = req.body || {};
    const sets = [];
    const vals = [];
    let i = 1;
    if (acl)        { sets.push(`acl = $${i++}`);        vals.push(acl); }
    if (category)   { sets.push(`category = $${i++}`);   vals.push(category); }
    if (importance) { sets.push(`importance = $${i++}`); vals.push(importance); }
    if (sets.length === 0) return reply.send({ updated: false });
    vals.push(id);
    await pool.query(`UPDATE knowledge_entries SET ${sets.join(", ")} WHERE id = $${i}`, vals);
    await audit({ actorRole: "admin", action: "knowledge.update", targetType: "knowledge_entry", targetId: id, payload: req.body });
    reply.send({ updated: true });
  });

  // Soft delete
  app.delete("/:id", async (req, reply) => {
    const { id } = req.params;
    const hard = req.query.hard === "true";
    if (hard) {
      await pool.query(`DELETE FROM knowledge_entries WHERE id = $1`, [id]);
      await audit({ actorRole: "admin", action: "knowledge.hard_delete", targetType: "knowledge_entry", targetId: id });
    } else {
      await pool.query(`UPDATE knowledge_entries SET deleted_at = now() WHERE id = $1`, [id]);
      await audit({ actorRole: "admin", action: "knowledge.soft_delete", targetType: "knowledge_entry", targetId: id });
    }
    reply.send({ deleted: true, hard });
  });

  // Aggregate stats — for admin dashboard
  app.get("/stats/summary", async (_req, reply) => {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)                                               AS total,
        COUNT(*) FILTER (WHERE acl = 'team')                   AS team_visible,
        COUNT(*) FILTER (WHERE acl = 'private')                AS private_only,
        COUNT(*) FILTER (WHERE source = 'chat')                AS from_chat,
        COUNT(*) FILTER (WHERE source = 'gmail')               AS from_gmail,
        COUNT(*) FILTER (WHERE created_at > now() - interval '7 days') AS last_7d
        FROM knowledge_entries WHERE deleted_at IS NULL`);
    reply.send(rows[0]);
  });
}
