// Bearer-token admin auth. Constant-time compare to avoid timing leaks.

import { timingSafeEqual } from "node:crypto";

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

function safeEq(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export async function requireAdmin(req, reply) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !safeEq(token, ADMIN_TOKEN)) {
    reply.code(401).send({ error: "unauthorized" });
    return reply;
  }
}
