// Gmail OAuth flow — redirect → Google consent → callback stores refresh token.
// Scope: gmail.readonly (worker enforces SENT-only at query time).

import { google } from "googleapis";
import { pool, audit } from "@cogent42-team/db";
import { encryptString } from "@cogent42-team/shared/crypto";
import { isAdminToken } from "../lib/auth.js";

const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

function makeOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_OAUTH_REDIRECT_URI
  );
}

export async function gmailRoutes(app) {
  // Admin starts OAuth for a user — returns the consent URL
  app.get("/oauth/start/:user_id", async (req, reply) => {
    // Auth gate (this route is registered BEFORE admin gate, so re-check token here)
    const header = req.headers.authorization || "";
    const token  = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!isAdminToken(token)) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    const { user_id } = req.params;
    const client = makeOAuthClient();
    const url = client.generateAuthUrl({
      access_type:    "offline",
      prompt:         "consent",                 // force refresh_token issuance
      scope:          SCOPES,
      state:          user_id,                   // round-tripped to callback
      include_granted_scopes: true,
    });
    reply.send({ url });
  });

  // Google redirects here after consent — public route (no admin token).
  app.get("/oauth/callback", async (req, reply) => {
    const { code, state, error } = req.query;
    if (error) return reply.code(400).send({ error });
    if (!code || !state) return reply.code(400).send({ error: "missing code or state" });

    const userId = String(state);
    const client = makeOAuthClient();
    const { tokens } = await client.getToken(code);

    if (!tokens.refresh_token) {
      return reply.code(400).type("text/html").send(
        `<h1>Gmail connect failed</h1><p>No refresh_token returned. Revoke access at <a href="https://myaccount.google.com/permissions">Google Account → Apps</a> and try again — Google only issues a refresh token on first consent.</p>`
      );
    }

    const expires = tokens.expiry_date ? new Date(tokens.expiry_date) : null;
    await pool.query(
      `INSERT INTO user_secrets (user_id, gmail_refresh_token_enc, gmail_access_token_enc, gmail_token_expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE
         SET gmail_refresh_token_enc = EXCLUDED.gmail_refresh_token_enc,
             gmail_access_token_enc  = EXCLUDED.gmail_access_token_enc,
             gmail_token_expires_at  = EXCLUDED.gmail_token_expires_at,
             updated_at = now()`,
      [
        userId,
        encryptString(tokens.refresh_token),
        encryptString(tokens.access_token),
        expires,
      ]
    );

    await audit({ actorRole: "admin", action: "gmail.connect", targetType: "user", targetId: userId });
    reply.type("text/html").send(`<h1>Gmail connected</h1><p>You can close this window.</p>`);
  });
}
