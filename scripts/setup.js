#!/usr/bin/env node
// Interactive setup — generates .env with secrets and prompts for keys.
// Run from repo root: node scripts/setup.js

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { randomBytes } from "node:crypto";

const ENV_PATH = ".env";
const EXAMPLE_PATH = ".env.example";

const rl = createInterface({ input: stdin, output: stdout });
const ask = (q, def = "") => rl.question(def ? `${q} [${def}]: ` : `${q}: `).then((a) => a.trim() || def);

function gen(bytes, fmt = "base64") { return randomBytes(bytes).toString(fmt); }

async function main() {
  console.log("\n🪄  cogent42-team setup\n");

  if (existsSync(ENV_PATH)) {
    const ok = (await ask(".env already exists. Overwrite? (y/N)", "N")).toLowerCase();
    if (ok !== "y") { console.log("Aborted."); rl.close(); return; }
  }

  if (!existsSync(EXAMPLE_PATH)) {
    console.error("Missing .env.example — run from repo root.");
    process.exit(1);
  }

  const template = readFileSync(EXAMPLE_PATH, "utf-8");
  const out = {};

  // Postgres
  out.POSTGRES_USER     = await ask("Postgres user", "cogent");
  out.POSTGRES_PASSWORD = await ask("Postgres password", gen(12, "hex"));
  out.POSTGRES_DB       = await ask("Postgres database", "cogent42_team");
  // DATABASE_URL is for host-run scripts (e.g. migrate.js). Postgres is published to 127.0.0.1.
  // In-container services build their own DATABASE_URL via docker-compose using the `postgres` host.
  out.DATABASE_URL      = `postgres://${out.POSTGRES_USER}:${out.POSTGRES_PASSWORD}@127.0.0.1:5432/${out.POSTGRES_DB}`;

  // Platform secrets
  out.MASTER_KEY  = gen(32, "base64");
  out.ADMIN_TOKEN = gen(24, "hex");
  console.log(`\n🔑  Generated MASTER_KEY  (32-byte): ${out.MASTER_KEY}`);
  console.log(`🔑  Generated ADMIN_TOKEN (24-byte): ${out.ADMIN_TOKEN}\n`);

  // LLM auth — Claude Code SDK only (no ANTHROPIC_API_KEY).
  // Containers run @anthropic-ai/claude-agent-sdk which spawns the `claude` CLI;
  // we mount the host's ~/.claude into each container so the CLI uses your existing session.
  const defaultClaudeHome = process.env.HOME ? `${process.env.HOME}/.claude` : "";
  out.CLAUDE_CODE_HOME = await ask("CLAUDE_CODE_HOME (host path to your ~/.claude)", defaultClaudeHome);
  if (!out.CLAUDE_CODE_HOME) {
    console.error("CLAUDE_CODE_HOME is required — install Claude Code on this host and run `claude` once before continuing.");
    rl.close();
    process.exit(1);
  }
  out.OPENAI_API_KEY    = await ask("OPENAI_API_KEY (for embeddings)");

  // Gmail OAuth (optional)
  console.log("\nGmail OAuth — optional. Press enter to skip; you can add later.");
  out.GOOGLE_CLIENT_ID          = await ask("GOOGLE_CLIENT_ID", "");
  out.GOOGLE_CLIENT_SECRET      = await ask("GOOGLE_CLIENT_SECRET", "");
  const publicHost              = await ask("Public host of control-plane (for OAuth redirect)", "http://localhost:8080");
  out.GOOGLE_OAUTH_REDIRECT_URI = `${publicHost.replace(/\/+$/, "")}/api/gmail/oauth/callback`;
  out.CONTROL_PLANE_PUBLIC_URL  = publicHost.replace(/\/+$/, "");

  // Defaults — taken from .env.example, not asked.
  const defaults = {
    CONTROL_PLANE_PORT: "8080",
    BOT_IMAGE:          "cogent42-team/bot:latest",
    BOT_NETWORK:        "cogent42-internal",
    BOT_MEM_LIMIT:      "512m",
    BOT_CPU_LIMIT:      "0.5",
    EXTRACTION_CONCURRENCY:    "4",
    GMAIL_POLL_INTERVAL_SEC:   "60",
    KNOWLEDGE_FRESHNESS_DAYS:  "90",
  };
  Object.assign(out, defaults);

  // Render — keep template's structure/comments, swap values.
  let rendered = template;
  for (const [k, v] of Object.entries(out)) {
    const re = new RegExp(`^${k}=.*$`, "m");
    if (re.test(rendered)) rendered = rendered.replace(re, `${k}=${v}`);
    else rendered += `\n${k}=${v}`;
  }
  writeFileSync(ENV_PATH, rendered);
  rl.close();

  console.log(`\n✅  Wrote ${ENV_PATH}\n`);
  console.log("Next steps:");
  console.log("  1) Build images:        npm run build:all");
  console.log("  2) Start stack:         npm run up");
  console.log("  3) Run migrations:      npm run migrate");
  console.log(`  4) Open admin UI:       ${publicHost}`);
  console.log(`     (paste ADMIN_TOKEN to unlock)\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
