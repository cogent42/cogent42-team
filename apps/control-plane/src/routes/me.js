// /me — per-user dashboard.
//
// Three public-ish surfaces, all gated by the magic-link → session cookie flow:
//   GET  /me/login?t=<raw>     redeems the magic link, mints a 10-min session
//   GET  /me                   serves the dashboard HTML (gated by cookie)
//   POST /me/logout            invalidates the current session
//   GET  /api/me               { user, stats }
//   GET  /api/me/facts         filter/search the caller's own facts
//   PATCH /api/me/facts/:id    update acl/category/importance (own facts only)
//   DELETE /api/me/facts/:id   soft-delete (own facts only)
//   PATCH /api/me              update gmail_mode / share_to_team

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pool, audit } from "@cogent42-team/db";
import {
  ME_SESSION_COOKIE,
  requireMeSession,
  sha256Hex,
} from "../lib/auth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// `me.html` is served from the same `public/` directory as `index.html` so
// fastify-static could pick it up too — but we read it ourselves so the
// session middleware can run first.
const ME_HTML = readFileSync(join(__dirname, "..", "..", "public", "me.html"), "utf-8");

const SESSION_TTL_MS = 10 * 60 * 1000;

function setSessionCookie(reply, raw) {
  // 10 minutes, Secure (we're behind Caddy → HTTPS), SameSite=Lax so a
  // top-level navigation from Telegram's in-app browser still carries it.
  reply.header(
    "Set-Cookie",
    `${ME_SESSION_COOKIE}=${raw}; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; HttpOnly; Secure; SameSite=Lax`
  );
}

function clearSessionCookie(reply) {
  reply.header(
    "Set-Cookie",
    `${ME_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
  );
}

export async function meRoutes(app) {
  // ── Magic-link redemption (public) ─────────────────────────────────────
  app.get("/login", async (req, reply) => {
    const raw = String(req.query.t || "");
    if (!raw) return reply.code(400).type("text/html").send("<h1>Missing token</h1>");

    // Single SQL: claim the magic link only if it's unused + unexpired.
    const claim = await pool.query(
      `UPDATE user_sessions
          SET used_at = now()
        WHERE token_hash = $1
          AND kind = 'magic_link'
          AND used_at IS NULL
          AND expires_at > now()
        RETURNING user_id`,
      [sha256Hex(raw)]
    );
    if (claim.rows.length === 0) {
      return reply
        .code(400)
        .type("text/html")
        .send(
          `<h1>Link expired or already used</h1>
           <p>Magic links are single-use and expire after 10 minutes. Run <code>/me</code> in your bot for a fresh one.</p>`
        );
    }
    const userId = claim.rows[0].user_id;

    // Mint a session token. We store sha256(raw) so DB compromise can't replay.
    const sessionRaw = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await pool.query(
      `INSERT INTO user_sessions (user_id, token_hash, kind, expires_at)
       VALUES ($1, $2, 'session', $3)`,
      [userId, sha256Hex(sessionRaw), expiresAt]
    );
    await audit({
      actorUserId: userId, actorRole: "user", action: "me.login",
      targetType: "user", targetId: userId,
    });

    setSessionCookie(reply, sessionRaw);
    reply.redirect("/me");
  });

  // ── Dashboard HTML (cookie-gated) ──────────────────────────────────────
  app.get("/", { onRequest: requireMeSession }, async (_req, reply) => {
    reply.type("text/html").send(ME_HTML);
  });

  // ── Logout ────────────────────────────────────────────────────────────
  app.post("/logout", { onRequest: requireMeSession }, async (req, reply) => {
    await pool.query(
      `UPDATE user_sessions SET used_at = now()
        WHERE user_id = $1 AND kind = 'session' AND used_at IS NULL`,
      [req.meUserId]
    );
    await audit({ actorUserId: req.meUserId, actorRole: "user", action: "me.logout" });
    clearSessionCookie(reply);
    reply.send({ ok: true });
  });
}

// Same auth gate, mounted under /api/me by index.js.
export async function meApiRoutes(app) {
  app.addHook("onRequest", requireMeSession);

  app.get("/", async (req, reply) => {
    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.name, u.slug, u.gmail_mode, u.share_to_team, u.created_at,
              (SELECT COUNT(*) FROM knowledge_entries
                WHERE owner_user_id = u.id AND deleted_at IS NULL) AS facts_total,
              (SELECT COUNT(*) FROM knowledge_entries
                WHERE owner_user_id = u.id AND deleted_at IS NULL AND acl = 'team') AS facts_team,
              (SELECT COUNT(*) FROM knowledge_entries
                WHERE owner_user_id = u.id AND deleted_at IS NULL AND acl = 'private') AS facts_private,
              (SELECT COUNT(*) FROM knowledge_entries
                WHERE owner_user_id = u.id AND deleted_at IS NULL
                  AND created_at > now() - interval '7 days') AS facts_last_7d,
              (SELECT (gmail_refresh_token_enc IS NOT NULL) FROM user_secrets
                WHERE user_id = u.id) AS gmail_connected
         FROM users u
        WHERE u.id = $1`,
      [req.meUserId]
    );
    if (rows.length === 0) return reply.code(404).send({ error: "not_found" });
    reply.send({ user: rows[0] });
  });

  app.patch("/", async (req, reply) => {
    const { gmail_mode, share_to_team } = req.body || {};
    const sets = [];
    const vals = [];
    let i = 1;
    if (gmail_mode    !== undefined) { sets.push(`gmail_mode = $${i++}`);    vals.push(gmail_mode); }
    if (share_to_team !== undefined) { sets.push(`share_to_team = $${i++}`); vals.push(share_to_team); }
    if (sets.length === 0) return reply.send({ updated: false });
    sets.push(`updated_at = now()`);
    vals.push(req.meUserId);
    await pool.query(`UPDATE users SET ${sets.join(", ")} WHERE id = $${i}`, vals);
    await audit({
      actorUserId: req.meUserId, actorRole: "user", action: "me.update",
      targetType: "user", targetId: req.meUserId, payload: req.body,
    });
    reply.send({ updated: true });
  });

  // ── Caller's own facts ────────────────────────────────────────────────
  app.get("/facts", async (req, reply) => {
    const q        = req.query.q || null;
    const category = req.query.category || null;
    const source   = req.query.source || null;
    const acl      = req.query.acl || null;
    const limit    = Math.min(parseInt(req.query.limit  || "100", 10), 500);
    const offset   = parseInt(req.query.offset || "0", 10);

    const conds = ["owner_user_id = $1", "deleted_at IS NULL"];
    const vals  = [req.meUserId];
    let i = 2;
    if (q)        { conds.push(`fact_tsv @@ plainto_tsquery('simple', $${i++})`); vals.push(q); }
    if (category) { conds.push(`category = $${i++}`); vals.push(category); }
    if (source)   { conds.push(`source = $${i++}`);   vals.push(source); }
    if (acl)      { conds.push(`acl = $${i++}`);      vals.push(acl); }
    vals.push(limit, offset);

    const { rows } = await pool.query(
      `SELECT id, fact, category, importance, acl, source, source_ref,
              evidence_count, validation_status, last_validated_at,
              created_at, last_seen_at
         FROM knowledge_entries
        WHERE ${conds.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT $${i++} OFFSET $${i++}`,
      vals
    );
    reply.send({ entries: rows });
  });

  app.patch("/facts/:id", async (req, reply) => {
    const { id } = req.params;
    const { acl, category, importance } = req.body || {};
    const sets = [];
    const vals = [];
    let i = 1;
    if (acl)        { sets.push(`acl = $${i++}`);        vals.push(acl); }
    if (category)   { sets.push(`category = $${i++}`);   vals.push(category); }
    if (importance) { sets.push(`importance = $${i++}`); vals.push(importance); }
    if (sets.length === 0) return reply.send({ updated: false });
    vals.push(id, req.meUserId);
    const { rowCount } = await pool.query(
      `UPDATE knowledge_entries SET ${sets.join(", ")}
        WHERE id = $${i++} AND owner_user_id = $${i++}`,
      vals
    );
    if (rowCount === 0) return reply.code(404).send({ error: "not_found" });
    await audit({
      actorUserId: req.meUserId, actorRole: "user", action: "me.fact.update",
      targetType: "knowledge_entry", targetId: id, payload: req.body,
    });
    reply.send({ updated: true });
  });

  app.delete("/facts/:id", async (req, reply) => {
    const { id } = req.params;
    const { rowCount } = await pool.query(
      `UPDATE knowledge_entries SET deleted_at = now()
        WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL`,
      [id, req.meUserId]
    );
    if (rowCount === 0) return reply.code(404).send({ error: "not_found" });
    await audit({
      actorUserId: req.meUserId, actorRole: "user", action: "me.fact.delete",
      targetType: "knowledge_entry", targetId: id,
    });
    reply.send({ deleted: true });
  });
}
