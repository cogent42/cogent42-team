// Two auth flavors:
//   1. Admin: bearer token (constant-time compared) on Authorization header.
//   2. /me: session cookie issued after redeeming a 10-minute magic link.

import { timingSafeEqual, createHash } from "node:crypto";
import { pool } from "@cogent42-team/db";

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

export const ME_SESSION_COOKIE = "cogent_me_session";

export function safeEq(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function isAdminToken(token) {
  return !!token && safeEq(token, ADMIN_TOKEN);
}

export function sha256Hex(s) {
  return createHash("sha256").update(s).digest("hex");
}

export async function requireAdmin(req, reply) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!isAdminToken(token)) {
    reply.code(401).send({ error: "unauthorized" });
    return reply;
  }
}

/** Parse a single cookie value out of `Cookie:` header. Avoids pulling in
 *  @fastify/cookie for one read. */
function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

/** onRequest hook for the /me dashboard + its API.
 *  Validates the session cookie against user_sessions; on success attaches
 *  `req.meUserId`. Treats any failure as 401 (HTML routes get a 302 to /). */
export async function requireMeSession(req, reply) {
  const raw = readCookie(req, ME_SESSION_COOKIE);
  if (!raw) return failMe(req, reply);

  const { rows } = await pool.query(
    `SELECT user_id, expires_at, used_at
       FROM user_sessions
      WHERE token_hash = $1 AND kind = 'session'
      LIMIT 1`,
    [sha256Hex(raw)]
  );
  const row = rows[0];
  if (!row || row.used_at || new Date(row.expires_at) <= new Date()) {
    return failMe(req, reply);
  }
  req.meUserId = row.user_id;
}

function failMe(req, reply) {
  // For HTML navigation, send the user back to the landing instead of a JSON 401.
  const accept = req.headers.accept || "";
  if (accept.includes("text/html")) {
    reply
      .header("Set-Cookie", `${ME_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`)
      .redirect("/");
    return reply;
  }
  reply.code(401).send({ error: "unauthorized" });
  return reply;
}
